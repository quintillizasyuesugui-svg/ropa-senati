"""Servidor del probador de uniforme SENATI.

Hace de punto de encuentro entre tres partes:
- el tablero (PC del encargado), que ve las fotos y descarga resultados;
- los celulares, que entran por QR y suben fotos;
- el motor (cuaderno de Colab/Kaggle con la GPU), que pide trabajo, pone el uniforme y devuelve el resultado.

Las fotos se guardan en el disco del servidor y, si hay claves de Cloudinary, también en la nube
(almacen.py), para que vuelvan cuando Render se reinicia. Todo se borra solo a las 6 horas.
"""
import io
import json
import re
import os
import secrets
import shutil
import threading
import time
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import almacen

RAIZ = Path(__file__).parent
DATOS = Path(os.environ.get("CARPETA_DATOS", "/tmp/probador"))
CLAVE_MOTOR = os.environ.get("CLAVE_MOTOR", "")
HORAS_GUARDADO = 6
MAX_BYTES = 8 * 1024 * 1024
TIPOS = {"chico", "chica"}

DATOS.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Probador de uniforme SENATI")
candado = threading.RLock()

# salas[sala] = {"creada": t, "fotos": {id: foto}, "siguiente": n}
salas: dict = {}
motor = {"visto": 0.0, "segundos_por_foto": 60.0, "nombre": ""}
# Varios cuadernos pueden trabajar a la vez: motores[nombre] = última vez que se reportó
motores = {}


def marcar_motor(nombre):
    motor["visto"] = ahora()
    motores[nombre or "motor"] = ahora()


def motores_activos():
    return sum(1 for visto in motores.values() if ahora() - visto < 20)


def ahora():
    return time.time()


def sala_o_404(sala):
    # Render gratis se duerme y al despertar olvida las salas: se rehace vacía con el mismo código
    # para que el tablero abierto y el QR ya escaneado sigan sirviendo.
    if sala not in salas:
        if not re.fullmatch(r"[A-Za-z0-9_-]{12}", sala or ""):
            raise HTTPException(404, "Esta sala no existe. Abre el tablero de nuevo.")
        with candado:
            salas.setdefault(sala, {"creada": ahora(), "fotos": {}, "siguiente": 1})
        (DATOS / sala).mkdir(parents=True, exist_ok=True)
    return salas[sala]


# ---------- Archivos: disco del servidor + copia en la nube ----------

def guardar(sala, nombre, contenido):
    (DATOS / sala).mkdir(parents=True, exist_ok=True)
    (DATOS / sala / nombre).write_bytes(contenido)
    almacen.guardar_archivo(sala, nombre, contenido)


def leer(sala, nombre):
    ruta = DATOS / sala / nombre
    if ruta.exists():
        return ruta.read_bytes()
    # Render se reinició y el disco quedó vacío: se trae de la nube y queda en disco otra vez
    contenido = almacen.bajar_archivo(sala, nombre)
    if contenido:
        (DATOS / sala).mkdir(parents=True, exist_ok=True)
        ruta.write_bytes(contenido)
    return contenido


def borrar(sala, nombre):
    (DATOS / sala / nombre).unlink(missing_ok=True)
    almacen.borrar_archivo(sala, nombre)


def armar_estado(sala):
    datos = salas.get(sala)
    if datos is None:
        return None
    with candado:
        fotos = {str(i): {k: v for k, v in f.items() if k not in ("paso", "motor")} for i, f in datos["fotos"].items()}
        return json.dumps({"creada": datos["creada"], "siguiente": datos["siguiente"], "fotos": fotos})


def recuperar_salas():
    limite = ahora() - HORAS_GUARDADO * 3600
    for sala, guardada in almacen.salas_guardadas().items():
        if guardada["creada"] < limite:
            almacen.borrar_sala(sala)
            continue
        fotos = {}
        for clave, foto in guardada["fotos"].items():
            foto.setdefault("paso", 0)
            # Lo que se estaba haciendo cuando Render se apagó vuelve a la fila
            if foto["estado"] == "haciendo":
                foto.update(estado=estado_de_espera(foto.get("ia")), paso=0, inicio=0)
            fotos[int(clave)] = foto
        # Salas de antes de que existiera el número visible: se numeran 1, 2, 3… en el orden en que llegaron
        if any("numero" not in f for f in fotos.values()):
            for numero, id_foto in enumerate(sorted(fotos), start=1):
                fotos[id_foto]["numero"] = numero
            almacen.guardar_estado(sala)
        salas[sala] = {"creada": guardada["creada"], "siguiente": guardada["siguiente"], "fotos": fotos}


def foto_o_404(sala, id_foto):
    datos = sala_o_404(sala)
    foto = datos["fotos"].get(id_foto)
    if not foto:
        raise HTTPException(404, "La foto ya no existe.")
    return foto


def revisar_clave(clave):
    if not CLAVE_MOTOR or not secrets.compare_digest(clave or "", CLAVE_MOTOR):
        raise HTTPException(401, "Clave del motor incorrecta.")


def publica(foto):
    datos = {k: foto.get(k) for k in ("id", "tipo", "origen", "ia", "estado", "paso", "pasos", "error", "creada", "inicio", "fin")}
    datos["numero"] = foto.get("numero", foto["id"])
    return datos


def limpiar_viejas():
    limite = ahora() - HORAS_GUARDADO * 3600
    with candado:
        for sala in [s for s, d in salas.items() if d["creada"] < limite]:
            shutil.rmtree(DATOS / sala, ignore_errors=True)
            del salas[sala]
            almacen.borrar_sala(sala)


# ---------- Páginas ----------

@app.get("/")
def inicio():
    limpiar_viejas()
    sala = secrets.token_urlsafe(9)
    with candado:
        salas[sala] = {"creada": ahora(), "fotos": {}, "siguiente": 1}
    (DATOS / sala).mkdir(parents=True, exist_ok=True)
    almacen.guardar_estado(sala)
    return RedirectResponse(f"/tablero?sala={sala}")


@app.get("/tablero")
def tablero():
    return FileResponse(RAIZ / "estatico" / "tablero.html")


@app.get("/celular")
def celular():
    return FileResponse(RAIZ / "estatico" / "celular.html")


# ---------- API de la sala (tablero y celulares) ----------

def estado_de_espera(ia):
    # «cola» la toma el motor de Colab; «gemini» la hace el navegador del tablero con Puter
    return "gemini" if ia == "gemini" else "cola"


@app.get("/api/salas/{sala}")
def estado_sala(sala: str):
    datos = sala_o_404(sala)
    fotos = sorted(datos["fotos"].values(), key=lambda f: (f.get("numero", f["id"]), f["id"]))
    en_fila = [f for f in fotos if f["estado"] in ("cola", "haciendo", "gemini")]
    return {
        "fotos": [publica(f) for f in fotos],
        "motor_conectado": ahora() - motor["visto"] < 20,
        "motores": motores_activos(),
        "segundos_por_foto": round(motor["segundos_por_foto"]),
        "en_fila": len(en_fila),
        "ahora": ahora(),
        "nube": {"activa": almacen.activo, "pendientes": almacen.estado["pendientes"],
                 "fallando": almacen.estado["fallando"]},
    }


@app.post("/api/salas/{sala}/fotos")
async def subir_foto(sala: str, foto: UploadFile = File(...), tipo: str = Form(...),
                     origen: str = Form("PC"), mayor: str = Form(""), ia: str = Form("colab")):
    datos = sala_o_404(sala)
    if tipo not in TIPOS:
        raise HTTPException(400, "Elige chico o chica.")
    if mayor != "si":
        raise HTTPException(400, "Solo se pueden procesar fotos de personas mayores de 18 años.")
    contenido = await foto.read()
    if len(contenido) > MAX_BYTES:
        raise HTTPException(413, "La foto pesa más de 8 MB.")
    if not contenido.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
        raise HTTPException(400, "El archivo no es una foto JPG, PNG o WEBP.")
    with candado:
        id_foto = datos["siguiente"]
        datos["siguiente"] += 1
        # El número que se ve es el más bajo libre: si borran la foto 1, la siguiente vuelve a ser la 1.
        # El id interno no se repite, así un resultado viejo del motor nunca cae en una foto nueva.
        usados = {f.get("numero", f["id"]) for f in datos["fotos"].values()}
        numero = next(n for n in range(1, len(usados) + 2) if n not in usados)
        guardar(sala, f"{id_foto}_original", contenido)
        datos["fotos"][id_foto] = {
            "id": id_foto, "numero": numero, "tipo": tipo, "origen": "Celular" if origen == "Celular" else "PC",
            "estado": estado_de_espera(ia), "ia": "gemini" if ia == "gemini" else "colab",
            "paso": 0, "pasos": 0, "error": "",
            "creada": ahora(), "inicio": 0, "fin": 0,
        }
    almacen.guardar_estado(sala)
    return {"id": id_foto}


@app.get("/api/salas/{sala}/fotos/{id_foto}/{cual}")
def ver_imagen(sala: str, id_foto: int, cual: str):
    foto_o_404(sala, id_foto)
    if cual not in ("original", "resultado"):
        raise HTTPException(404)
    contenido = leer(sala, f"{id_foto}_{cual}")
    if not contenido:
        raise HTTPException(404, "Todavía no hay resultado.")
    return Response(contenido, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/api/salas/{sala}/fotos/{id_foto}/repetir")
def repetir(sala: str, id_foto: int, tipo: str = Form(...), ia: str = Form("")):
    foto = foto_o_404(sala, id_foto)
    if tipo not in TIPOS:
        raise HTTPException(400, "Elige chico o chica.")
    with candado:
        if foto["estado"] == "haciendo":
            raise HTTPException(409, "Esta foto se está procesando ahora.")
        if ia in ("colab", "gemini"):
            foto["ia"] = ia
        foto.update(tipo=tipo, estado=estado_de_espera(foto.get("ia")), paso=0, pasos=0, error="", inicio=0, fin=0)
        borrar(sala, f"{id_foto}_resultado")
    almacen.guardar_estado(sala)
    return {"ok": True}


@app.post("/api/salas/{sala}/fotos/{id_foto}/resultado-gemini")
async def resultado_gemini(sala: str, id_foto: int, imagen: UploadFile = File(None), error: str = Form("")):
    """Resultado hecho en el navegador con Gemini (Puter)."""
    foto = foto_o_404(sala, id_foto)
    if error:
        with candado:
            foto.update(estado="error", error=error[:200], fin=ahora())
        almacen.guardar_estado(sala)
        return {"ok": True}
    if imagen is None:
        raise HTTPException(400, "Falta la imagen.")
    contenido = await imagen.read()
    if len(contenido) > MAX_BYTES:
        raise HTTPException(413, "La imagen de Gemini pesa más de 8 MB.")
    if not contenido.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
        raise HTTPException(400, "Gemini no devolvió una imagen válida.")
    with candado:
        if foto["estado"] == "haciendo":
            raise HTTPException(409, "Esta foto se está procesando ahora.")
        guardar(sala, f"{id_foto}_resultado", contenido)
        foto.update(estado="lista", error="", fin=ahora())
    almacen.guardar_estado(sala)
    return {"ok": True}


@app.delete("/api/salas/{sala}/fotos/{id_foto}")
def borrar_foto(sala: str, id_foto: int):
    datos = sala_o_404(sala)
    with candado:
        datos["fotos"].pop(id_foto, None)
        for cual in ("original", "resultado"):
            borrar(sala, f"{id_foto}_{cual}")
    almacen.guardar_estado(sala)
    return {"ok": True}


@app.delete("/api/salas/{sala}")
def borrar_sala(sala: str):
    sala_o_404(sala)
    with candado:
        shutil.rmtree(DATOS / sala, ignore_errors=True)
        del salas[sala]
    almacen.borrar_sala(sala)
    return {"ok": True}


@app.get("/api/salas/{sala}/zip")
def descargar_zip(sala: str):
    datos = sala_o_404(sala)
    memoria = io.BytesIO()
    with zipfile.ZipFile(memoria, "w", zipfile.ZIP_STORED) as z:
        for foto in sorted(datos["fotos"].values(), key=lambda f: (f.get("numero", f["id"]), f["id"])):
            contenido = leer(sala, f"{foto['id']}_resultado") if foto["estado"] == "lista" else None
            if contenido:
                z.writestr(f"uniforme_{foto.get('numero', foto['id']):03d}_{foto['tipo']}.jpg", contenido)
    memoria.seek(0)
    return StreamingResponse(memoria, media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="uniformes_senati.zip"'})


# ---------- API del motor (cuaderno con GPU) ----------

@app.post("/api/motor/trabajo")
def pedir_trabajo(x_clave: str = Header(""), nombre: str = Form("motor")):
    revisar_clave(x_clave)
    marcar_motor(nombre)
    with candado:
        pendientes = [(f["creada"], s, f) for s, d in salas.items() for f in d["fotos"].values() if f["estado"] == "cola"]
        if not pendientes:
            return Response(status_code=204)
        _, sala, foto = min(pendientes, key=lambda x: x[0])
        foto.update(estado="haciendo", inicio=ahora(), paso=0, motor=nombre)
    imagen = leer(sala, f"{foto['id']}_original")
    if not imagen:
        with candado:
            foto.update(estado="error", error="No se encontró la foto original.", fin=ahora())
        return Response(status_code=204)
    return Response(imagen, media_type="application/octet-stream",
                    headers={"X-Sala": sala, "X-Foto": str(foto["id"]), "X-Tipo": foto["tipo"]})


@app.post("/api/motor/avance/{sala}/{id_foto}")
def avance(sala: str, id_foto: int, paso: int = Form(...), pasos: int = Form(...), x_clave: str = Header("")):
    revisar_clave(x_clave)
    foto = foto_o_404(sala, id_foto)
    marcar_motor(foto.get("motor"))
    foto.update(paso=paso, pasos=pasos)
    return {"ok": True}


@app.post("/api/motor/resultado/{sala}/{id_foto}")
async def resultado(sala: str, id_foto: int, imagen: UploadFile = File(None), error: str = Form(""),
                    x_clave: str = Header("")):
    revisar_clave(x_clave)
    foto = foto_o_404(sala, id_foto)
    marcar_motor(foto.get("motor"))
    if error:
        foto.update(estado="error", error=error[:200], fin=ahora())
        almacen.guardar_estado(sala)
        return {"ok": True}
    guardar(sala, f"{id_foto}_resultado", await imagen.read())
    duracion = ahora() - foto["inicio"]
    # Promedio móvil para calcular cuánto falta en la fila
    motor["segundos_por_foto"] = motor["segundos_por_foto"] * 0.7 + duracion * 0.3
    foto.update(estado="lista", fin=ahora(), paso=foto["pasos"])
    almacen.guardar_estado(sala)
    return {"ok": True}


@app.get("/api/salud")
def salud():
    return {"ok": True, "motor_conectado": ahora() - motor["visto"] < 20}


@app.on_event("startup")
def al_arrancar():
    recuperar_salas()
    almacen.arrancar(armar_estado)


app.mount("/estatico", StaticFiles(directory=RAIZ / "estatico"), name="estatico")
