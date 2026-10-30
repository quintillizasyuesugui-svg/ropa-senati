// Utilidades compartidas por el tablero y el celular.
const sala = new URLSearchParams(location.search).get('sala');

async function api(ruta, opciones = {}) {
  const respuesta = await fetch(`/api/salas/${sala}${ruta}`, opciones);
  if (!respuesta.ok) {
    let mensaje = `Error ${respuesta.status}`;
    try { mensaje = (await respuesta.json()).detail || mensaje; } catch (e) { /* sin cuerpo JSON */ }
    throw new Error(mensaje);
  }
  return respuesta.headers.get('content-type')?.includes('json') ? respuesta.json() : respuesta;
}

// Achica la foto a 1280 px de lado mayor antes de subirla: sube más rápido y el modelo trabaja a 1024 igual
function reducirFoto(archivo, lado = 1280) {
  return new Promise((resolver, rechazar) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, lado / Math.max(img.width, img.height));
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.width * escala);
      lienzo.height = Math.round(img.height * escala);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
      lienzo.toBlob(b => (b ? resolver(b) : rechazar(new Error('No se pudo leer la foto.'))), 'image/jpeg', 0.9);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => rechazar(new Error('Ese archivo no es una foto que el navegador pueda abrir.'));
    img.src = URL.createObjectURL(archivo);
  });
}

async function subirFoto(archivo, tipo, origen) {
  const datos = new FormData();
  datos.append('foto', await reducirFoto(archivo), 'foto.jpg');
  datos.append('tipo', tipo);
  datos.append('origen', origen);
  datos.append('mayor', 'si');
  return api('/fotos', { method: 'POST', body: datos });
}

function textoTiempo(segundos) {
  segundos = Math.max(0, Math.round(segundos));
  if (segundos < 60) return `${segundos} s`;
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// Comparador: se arrastra la barra para ver antes y después
function activarComparador(caja) {
  const mover = x => {
    const r = caja.getBoundingClientRect();
    caja.style.setProperty('--corte', Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)) + '%');
  };
  caja.addEventListener('pointerdown', e => { caja.setPointerCapture(e.pointerId); mover(e.clientX); });
  caja.addEventListener('pointermove', e => { if (caja.hasPointerCapture(e.pointerId)) mover(e.clientX); });
  caja.addEventListener('keydown', e => {
    const actual = parseFloat(caja.style.getPropertyValue('--corte')) || 50;
    if (e.key === 'ArrowLeft') caja.style.setProperty('--corte', Math.max(0, actual - 5) + '%');
    if (e.key === 'ArrowRight') caja.style.setProperty('--corte', Math.min(100, actual + 5) + '%');
  });
}
