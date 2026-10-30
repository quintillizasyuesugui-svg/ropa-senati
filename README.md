# Probador de uniforme SENATI

Página para eventos: los celulares toman fotos por QR, la PC del encargado las ve en un tablero y un cuaderno de Colab/Kaggle con GPU les pone el uniforme SENATI con IA (CatVTON). La cara, la pose y el fondo quedan igual.

## Cómo funciona

1. **Tablero** (`/`): abre una sala nueva con su QR. Muestra cada foto, su avance real paso a paso y cuánto falta para toda la fila.
2. **Celular** (`/celular?sala=…`): se abre con el QR. Toma la foto, elige chico o chica y la manda.
3. **Motor**: el paso 8 del cuaderno `cambiar_uniforme.ipynb` pide fotos a la página cada 2 segundos, las procesa y devuelve el resultado. Pueden correr varios motores a la vez.

## Reglas

- Solo fotos de personas mayores de 18 años (casilla obligatoria).
- El filtro de seguridad del modelo se respeta: si bloquea una foto, no se reintenta.
- Las fotos viven solo en el disco temporal del servidor y se borran a las 6 horas, o al tocar «Borrar todas las fotos».

## Publicar en Render

`render.yaml` crea el servicio gratis y genera la variable `CLAVE_MOTOR`. Esa clave se escribe en el paso 8 del cuaderno.

## Probar en la PC

```
pip install -r requirements.txt
set CLAVE_MOTOR=una-clave
uvicorn app:app --port 8000
```
