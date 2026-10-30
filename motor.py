"""Motor del evento: corre en Colab/Kaggle junto al modelo CatVTON.

Pide fotos a la página cada 2 segundos, les pone el uniforme y devuelve el resultado.
El filtro de seguridad del modelo se respeta: si bloquea una foto, se avisa y no se reintenta.

Uso en el cuaderno (después de cargar el modelo y la función vestir):
    import motor
    motor.encender(pipeline, vestir, uniformes, clave)
"""
import io
import threading
import time

import requests
from PIL import Image

DIRECCION = "https://ropa-senati.onrender.com"


def encender(pipeline, vestir, uniformes, clave, direccion=DIRECCION, pasos=50):
    cabecera = {"X-Clave": clave}
    nombre_motor = f"colab-{int(time.time()) % 10000}"

    # Cuenta los pasos de la IA para mandar el avance real a la página
    contador = {"paso": 0}
    paso_original = pipeline.noise_scheduler.step

    def paso_vigilado(*args, **kwargs):
        contador["paso"] += 1
        return paso_original(*args, **kwargs)

    pipeline.noise_scheduler.step = paso_vigilado

    # Avisa si el filtro de seguridad bloqueó la imagen
    bloqueo = {"si": False}
    filtro_original = pipeline.run_safety_checker

    def filtro_vigilado(image):
        imagen, marcas = filtro_original(image)
        bloqueo["si"] = bool(marcas) and any(marcas)
        return imagen, marcas

    pipeline.run_safety_checker = filtro_vigilado

    def mandar_avance(sala, id_foto, terminado):
        url = f"{direccion}/api/motor/avance/{sala}/{id_foto}"
        while not terminado.is_set():
            try:
                requests.post(url, headers=cabecera, timeout=10,
                              data={"paso": contador["paso"], "pasos": pasos})
            except requests.RequestException:
                pass
            terminado.wait(1.5)

    def devolver(sala, id_foto, imagen=None, error=""):
        url = f"{direccion}/api/motor/resultado/{sala}/{id_foto}"
        for _ in range(3):
            try:
                if imagen is None:
                    requests.post(url, headers=cabecera, data={"error": error}, timeout=60)
                else:
                    memoria = io.BytesIO()
                    imagen.save(memoria, "JPEG", quality=92)
                    requests.post(url, headers=cabecera, timeout=60,
                                  files={"imagen": ("resultado.jpg", memoria.getvalue(), "image/jpeg")})
                return
            except requests.RequestException:
                time.sleep(3)

    print("Motor encendido. Esperando fotos de la página…")
    hechas = 0
    while True:
        try:
            r = requests.post(f"{direccion}/api/motor/trabajo", headers=cabecera,
                              data={"nombre": nombre_motor}, timeout=90)
        except requests.RequestException:
            print("Sin conexión con la página, reintento en 5 s")
            time.sleep(5)
            continue
        if r.status_code == 401:
            print("Clave del motor incorrecta. Revisa el secreto CLAVE_MOTOR (ícono de la llave).")
            return
        if r.status_code == 204:
            time.sleep(2)
            continue
        if r.status_code != 200:
            print("La página respondió", r.status_code, "- reintento en 5 s")
            time.sleep(5)
            continue

        sala, id_foto, tipo = r.headers["X-Sala"], r.headers["X-Foto"], r.headers["X-Tipo"]
        inicio = time.time()
        contador["paso"] = 0
        bloqueo["si"] = False
        terminado = threading.Event()
        threading.Thread(target=mandar_avance, args=(sala, id_foto, terminado), daemon=True).start()
        try:
            persona = Image.open(io.BytesIO(r.content))
            uniforme = uniformes["hombre" if tipo == "chico" else "mujer"]
            final = vestir(persona, uniforme, pasos)
            terminado.set()
            if bloqueo["si"]:
                devolver(sala, id_foto, error="El filtro de seguridad bloqueó esta foto. "
                                              "Toma otra de frente, cuerpo entero y brazos abajo.")
                print(f"Foto {id_foto}: bloqueada por el filtro")
            else:
                devolver(sala, id_foto, imagen=final)
                hechas += 1
                print(f"Foto {id_foto} ({tipo}) lista en {time.time() - inicio:.0f} s · total {hechas}")
        except Exception as error:
            terminado.set()
            devolver(sala, id_foto, error=f"Falló al poner el uniforme: {error}")
            print(f"Foto {id_foto}: error {error}")
