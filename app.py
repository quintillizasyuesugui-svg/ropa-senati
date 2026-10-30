"""Servidor del probador de uniforme SENATI.

Hace de punto de encuentro entre tres partes:
- el tablero (PC del encargado), que ve las fotos y descarga resultados;
- los celulares, que entran por QR y suben fotos;
- el motor (cuaderno de Colab/Kaggle con la GPU), que pide trabajo, pone el uniforme y devuelve el resultado.

Las fotos se guardan solo en el disco temporal del servidor y se borran solas a las 6 horas.
"""
import io
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
    return {k: foto[k] for k in ("id", "tipo", "origen", "estado", "paso", "pasos", "error", "creada", "inicio", "fin")}


def limpiar_viejas():
    limite = ahora() - HORAS_GUARDADO * 3600
    with candado:
        for sala in [s for s, d in salas.items() if d["creada"] < limite]:
            shutil.rmtree(DATOS / sala, ignore_errors=True)
            del salas[sala]


# ---------- Páginas ----------

@app.get("/")
def inicio():
    limpiar_viejas()
    sala = secrets.token_urlsafe(9)
    with candado:
        salas[sala] = {"creada": ahora(), "fotos": {}, "siguiente": 1}
    (DATOS / sala).mkdir(parents=True, exist_ok=True)
    return RedirectResponse(f"/tablero?sala={sala}")


@app.get("/tablero")
def tablero():
    return FileResponse(RAIZ / "estatico" / "tablero.html")


@app.get("/celular")
def celular():
    return FileResponse(RAIZ / "estatico" / "celular.html")


# ---------- API de la sala (tablero y celulares) ----------

@app.get("/api/salas/{sala}")
def estado_sala(sala: str):
    datos = sala_o_404(sala)
    fotos = sorted(datos["fotos"].values(), key=lambda f: f["id"])
    en_fila = [f for f in fotos if f["estado"] in ("cola", "haciendo")]
    return {
        "fotos": [publica(f) for f in fotos],
        "motor_conectado": ahora() - motor["visto"] < 20,
        "segundos_por_foto": round(motor["segundos_por_foto"]),
        "en_fila": len(en_fila),
        "ahora": ahora(),
    }


@app.post("/api/salas/{sala}/fotos")
async def subir_foto(sala: str, foto: UploadFile = File(...), tipo: str = Form(...),
                     origen: str = Form("PC"), mayor: str = Form("")):
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
        (DATOS / sala / f"{id_foto}_original").write_bytes(contenido)
        datos["fotos"][id_foto] = {
            "id": id_foto, "tipo": tipo, "origen": "Celular" if origen == "Celular" else "PC",
            "estado": "cola", "paso": 0, "pasos": 0, "error": "",
            "creada": ahora(), "inicio": 0, "fin": 0,
        }
    return {"id": id_foto}


@app.get("/api/salas/{sala}/fotos/{id_foto}/{cual}")
def ver_imagen(sala: str, id_foto: int, cual: str):
    foto_o_404(sala, id_foto)
    if cual not in ("original", "resultado"):
        raise HTTPException(404)
    ruta = DATOS / sala / f"{id_foto}_{cual}"
    if not ruta.exists():
        raise HTTPException(404, "Todavía no hay resultado.")
    return Response(ruta.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/api/salas/{sala}/fotos/{id_foto}/repetir")
def repetir(sala: str, id_foto: int, tipo: str = Form(...)):
    foto = foto_o_404(sala, id_foto)
    if tipo not in TIPOS:
        raise HTTPException(400, "Elige chico o chica.")
    with candado:
        if foto["estado"] == "haciendo":
            raise HTTPException(409, "Esta foto se está procesando ahora.")
        foto.update(tipo=tipo, estado="cola", paso=0, pasos=0, error="", inicio=0, fin=0)
        (DATOS / sala / f"{id_foto}_resultado").unlink(missing_ok=True)
    return {"ok": True}


@app.delete("/api/salas/{sala}/fotos/{id_foto}")
def borrar_foto(sala: str, id_foto: int):
    datos = sala_o_404(sala)
    with candado:
        datos["fotos"].pop(id_foto, None)
        for cual in ("original", "resultado"):
            (DATOS / sala / f"{id_foto}_{cual}").unlink(missing_ok=True)
    return {"ok": True}


@app.delete("/api/salas/{sala}")
def borrar_sala(sala: str):
    sala_o_404(sala)
    with candado:
        shutil.rmtree(DATOS / sala, ignore_errors=True)
        del salas[sala]
    return {"ok": True}


@app.get("/api/salas/{sala}/zip")
def descargar_zip(sala: str):
    datos = sala_o_404(sala)
    memoria = io.BytesIO()
    with zipfile.ZipFile(memoria, "w", zipfile.ZIP_STORED) as z:
        for foto in sorted(datos["fotos"].values(), key=lambda f: f["id"]):
            ruta = DATOS / sala / f"{foto['id']}_resultado"
            if ruta.exists():
                z.write(ruta, f"uniforme_{foto['id']:03d}_{foto['tipo']}.jpg")
    memoria.seek(0)
    return StreamingResponse(memoria, media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="uniformes_senati.zip"'})


# ---------- API del motor (cuaderno con GPU) ----------

@app.post("/api/motor/trabajo")
def pedir_trabajo(x_clave: str = Header(""), nombre: str = Form("motor")):
    revisar_clave(x_clave)
    motor["visto"] = ahora()
    motor["nombre"] = nombre
    with candado:
        pendientes = [(f["creada"], s, f) for s, d in salas.items() for f in d["fotos"].values() if f["estado"] == "cola"]
        if not pendientes:
            return Response(status_code=204)
        _, sala, foto = min(pendientes, key=lambda x: x[0])
        foto.update(estado="haciendo", inicio=ahora(), paso=0)
    imagen = (DATOS / sala / f"{foto['id']}_original").read_bytes()
    return Response(imagen, media_type="application/octet-stream",
                    headers={"X-Sala": sala, "X-Foto": str(foto["id"]), "X-Tipo": foto["tipo"]})


@app.post("/api/motor/avance/{sala}/{id_foto}")
def avance(sala: str, id_foto: int, paso: int = Form(...), pasos: int = Form(...), x_clave: str = Header("")):
    revisar_clave(x_clave)
    motor["visto"] = ahora()
    foto = foto_o_404(sala, id_foto)
    foto.update(paso=paso, pasos=pasos)
    return {"ok": True}


@app.post("/api/motor/resultado/{sala}/{id_foto}")
async def resultado(sala: str, id_foto: int, imagen: UploadFile = File(None), error: str = Form(""),
                    x_clave: str = Header("")):
    revisar_clave(x_clave)
    motor["visto"] = ahora()
    foto = foto_o_404(sala, id_foto)
    if error:
        foto.update(estado="error", error=error[:200], fin=ahora())
        return {"ok": True}
    (DATOS / sala / f"{id_foto}_resultado").write_bytes(await imagen.read())
    duracion = ahora() - foto["inicio"]
    # Promedio móvil para calcular cuánto falta en la fila
    motor["segundos_por_foto"] = motor["segundos_por_foto"] * 0.7 + duracion * 0.3
    foto.update(estado="lista", fin=ahora(), paso=foto["pasos"])
    return {"ok": True}


@app.get("/api/salud")
def salud():
    return {"ok": True, "motor_conectado": ahora() - motor["visto"] < 20}


app.mount("/estatico", StaticFiles(directory=RAIZ / "estatico"), name="estatico")
