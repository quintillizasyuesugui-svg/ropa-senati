# Probador de uniforme SENATI

Página para eventos: los celulares mandan fotos por QR, la PC del encargado las ve en un tablero, y una IA les pone el uniforme SENATI. La cara, la pose y el fondo no cambian.

Página: https://ropa-senati.onrender.com

## Cómo funciona

1. **Tablero** (`/`): abre una sala nueva con su QR. Muestra cada foto, el avance paso a paso y cuánto falta para toda la fila.
2. **Celular** (`/celular?sala=…`): se abre con el QR. Toma la foto y elige **Chico/Chica** y **IA Colab / IA Gemini** antes de mandarla.
3. **Subir desde la PC**: el botón «Subir fotos» abre una ventana para soltar varias fotos, ver las miniaturas y elegir uniforme e IA.
4. **Si una foto falla o no gusta**: al abrirla salen «Repetir con Colab» y «Repetir con Gemini». El resultado nuevo reemplaza al anterior.
5. **Tacho** en cada foto (dos toques) y «Borrar todas las fotos».

## Las dos IA

- **Colab** (gratis, sin límite, ~1 minuto por foto): el cuaderno `cambiar_uniforme.ipynb` con el modelo CatVTON y una GPU T4. Pide fotos a la página cada 2 segundos. Pueden trabajar varios cuadernos a la vez, uno por cuenta de Google.
- **Gemini por Puter** (~30 segundos, pocas fotos por cuenta): lo hace el navegador del tablero con el saldo gratis del mes de la cuenta de Puter. Arriba se ve el saldo y para cuántas fotos alcanza. Tocando el saldo se cambia de cuenta. Puter no cobra: cuando se acaba el saldo, la página se detiene y pide otra cuenta.

## Encender el motor de Colab

En una sesión nueva, con la GPU T4 elegida:

1. **Paso 2**: instala el modelo. Al terminar la sesión se reinicia sola.
2. **Paso 4**: carga el modelo.
3. **Paso 5**: prepara los uniformes. Si no se subió el ZIP, los baja solo de esta página.
4. **Paso 8**: motor del evento. Debe decir «Motor encendido» y el tablero «Motor conectado».

El paso 8 necesita la clave del motor (variable `CLAVE_MOTOR` de Render). No compartir un cuaderno que la tenga escrita.

## Dónde quedan las fotos

- En el disco del servidor y, si están las variables `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET`, también en Cloudinary (privadas, carpeta `ropa-senati`). Así vuelven si Render se reinicia o se duerme.
- Si falla el internet, la página sigue funcionando y reintenta guardar sola.
- Todo se borra a las 6 horas, con el tacho o con «Borrar todas las fotos», también en Cloudinary.

## Reglas

- Solo fotos de personas mayores de 18 años (casilla obligatoria).
- El filtro de seguridad del modelo se respeta: si bloquea una foto, no se reintenta a escondidas.

## Probar en la PC

```
pip install -r requirements.txt
set CLAVE_MOTOR=una-clave
uvicorn app:app --port 8000
```

Sin las variables de Cloudinary guarda solo en disco.
