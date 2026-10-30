"""Copia de las salas y sus fotos en Cloudinary, para que sobrevivan cuando Render se reinicia o se duerme.

- Todo se guarda privado (type «authenticated») dentro de la carpeta «ropa-senati/<sala>/».
- Las escrituras pasan por una fila que atiende un solo hilo, en orden: primero la foto, después el estado
  que la nombra. Si falla el internet, reintenta la misma tarea con esperas crecientes y la página sigue
  funcionando con la copia del disco.
- Lo que se borra en la página (tacho, «Borrar todas», limpieza de 6 horas) se borra también aquí.
- Sin las variables CLOUDINARY_* el almacén queda apagado y el servidor guarda solo en disco.
"""
import io
import json
import logging
import os
import queue
import threading
import time
import urllib.request

registro = logging.getLogger("almacen")

CARPETA = "ropa-senati"
_nube = None
_fila: "queue.Queue" = queue.Queue()
estado = {"pendientes": 0, "fallando": False, "ultimo_error": ""}

if all(os.environ.get(k) for k in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET")):
    import cloudinary
    import cloudinary.api
    import cloudinary.uploader
    import cloudinary.utils

    cloudinary.config(
        cloud_name=os.environ["CLOUDINARY_CLOUD_NAME"],
        api_key=os.environ["CLOUDINARY_API_KEY"],
        api_secret=os.environ["CLOUDINARY_API_SECRET"],
        secure=True,
    )
    _nube = cloudinary

activo = _nube is not None


def _id(sala, nombre):
    return f"{CARPETA}/{sala}/{nombre}"


def _subir_ahora(sala, nombre, contenido):
    _nube.uploader.upload(io.BytesIO(contenido), public_id=_id(sala, nombre), resource_type="raw",
                          type="authenticated", overwrite=True, invalidate=True)


def _bajar_ahora(sala, nombre):
    url = _nube.utils.private_download_url(_id(sala, nombre), "", resource_type="raw", type="authenticated")
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def _hacer(tarea, armar_estado):
    clase = tarea[0]
    if clase == "subir":
        _, sala, nombre, contenido = tarea
        _subir_ahora(sala, nombre, contenido)
    elif clase == "estado":
        texto = armar_estado(tarea[1])
        if texto is not None:
            _subir_ahora(tarea[1], "estado.json", texto.encode("utf-8"))
    elif clase == "borrar":
        _, sala, nombre = tarea
        _nube.uploader.destroy(_id(sala, nombre), resource_type="raw", type="authenticated", invalidate=True)
    elif clase == "borrar_sala":
        _nube.api.delete_resources_by_prefix(f"{CARPETA}/{tarea[1]}/", resource_type="raw", type="authenticated")


def _trabajar(armar_estado):
    while True:
        tarea = _fila.get()
        # Si ya hay otro guardado del mismo estado más adelante en la fila, este sobra
        if tarea[0] == "estado" and any(t[0] == "estado" and t[1] == tarea[1] for t in list(_fila.queue)):
            estado["pendientes"] = _fila.qsize()
            continue
        espera = 2
        while True:
            try:
                _hacer(tarea, armar_estado)
                estado.update(fallando=False, ultimo_error="")
                break
            except Exception as error:  # sin internet, Cloudinary caído, límite de pedidos…
                estado.update(fallando=True, ultimo_error=str(error)[:200])
                registro.warning("Cloudinary falló (%s), reintento en %s s: %s", tarea[0], espera, error)
                time.sleep(espera)
                espera = min(espera * 2, 60)
        estado["pendientes"] = _fila.qsize()


def arrancar(armar_estado):
    """armar_estado(sala) -> texto JSON del estado actual de la sala, o None si ya no existe."""
    if activo:
        threading.Thread(target=_trabajar, args=(armar_estado,), daemon=True).start()


def _encolar(tarea):
    if activo:
        _fila.put(tarea)
        estado["pendientes"] = _fila.qsize()


def guardar_archivo(sala, nombre, contenido):
    _encolar(("subir", sala, nombre, contenido))


def guardar_estado(sala):
    _encolar(("estado", sala))


def borrar_archivo(sala, nombre):
    _encolar(("borrar", sala, nombre))


def borrar_sala(sala):
    _encolar(("borrar_sala", sala))


def bajar_archivo(sala, nombre):
    """Trae un archivo de la nube (cuando el disco del servidor ya no lo tiene). None si no se pudo."""
    if not activo:
        return None
    try:
        return _bajar_ahora(sala, nombre)
    except Exception as error:
        registro.warning("No se pudo bajar %s/%s: %s", sala, nombre, error)
        return None


def salas_guardadas():
    """Lee de la nube el estado de todas las salas guardadas: {sala: dict}."""
    if not activo:
        return {}
    encontradas, cursor = {}, None
    try:
        while True:
            pedido = dict(type="authenticated", resource_type="raw", prefix=f"{CARPETA}/", max_results=500)
            if cursor:
                pedido["next_cursor"] = cursor
            respuesta = _nube.api.resources(**pedido)
            for recurso in respuesta.get("resources", []):
                partes = recurso["public_id"].split("/")
                if len(partes) == 3 and partes[2] == "estado.json":
                    encontradas[partes[1]] = None
            cursor = respuesta.get("next_cursor")
            if not cursor:
                break
        for sala in list(encontradas):
            texto = bajar_archivo(sala, "estado.json")
            if texto:
                encontradas[sala] = json.loads(texto)
            else:
                del encontradas[sala]
    except Exception as error:
        registro.warning("No se pudieron leer las salas guardadas: %s", error)
    return encontradas
