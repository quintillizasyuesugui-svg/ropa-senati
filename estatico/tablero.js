// Tablero del encargado: muestra las fotos de la sala y se actualiza cada 1,5 s.
const rejilla = document.getElementById('rejilla');
const vacio = document.getElementById('vacio');
const tarjetas = new Map();
let ultimo = null;
let abierta = null;
let tipoSubida = 'chica';
let tipoRepetir = 'chica';

if (!sala) location.href = '/';
document.getElementById('zip').href = `/api/salas/${sala}/zip`;

// QR que abre la página del celular en esta misma sala
const enlaceCelular = `${location.origin}/celular?sala=${encodeURIComponent(sala)}`;
if (window.qrcode) {
  const qr = qrcode(0, 'M');
  qr.addData(enlaceCelular);
  qr.make();
  document.getElementById('qr').innerHTML = qr.createSvgTag({ margin: 0, scalable: true });
} else {
  document.getElementById('qr').textContent = enlaceCelular;
}

const textoEstado = f => ({
  cola: 'En espera',
  haciendo: f.pasos ? `Poniendo ${Math.round((f.paso / f.pasos) * 100)}%` : 'Empezando…',
  lista: 'Lista',
  error: 'No se pudo',
}[f.estado]);

function faltaFoto(f, datos) {
  if (f.estado === 'cola') return datos.segundos_por_foto;
  if (f.estado !== 'haciendo') return 0;
  const pasado = datos.ahora - f.inicio;
  if (f.paso > 0) return ((f.pasos - f.paso) * pasado) / f.paso + 3;
  return Math.max(5, datos.segundos_por_foto - pasado);
}

function crearTarjeta(f) {
  const boton = document.createElement('button');
  boton.className = 'tarjeta';
  boton.innerHTML = `<div class="img"><img alt="" loading="lazy"><span class="chip"></span>
      <div class="progreso" hidden><i></i></div></div>
    <div class="datos"><b>Foto ${f.id}</b><span class="info"></span></div>`;
  boton.querySelector('img').src = `/api/salas/${sala}/fotos/${f.id}/original`;
  boton.addEventListener('click', () => abrirDetalle(f.id));
  rejilla.prepend(boton);
  return { boton, estado: null, tipo: null };
}

function pintarTarjeta(t, f, datos) {
  const chip = t.boton.querySelector('.chip');
  chip.className = `chip ${f.estado === 'haciendo' ? 'haciendo' : f.estado}`;
  chip.textContent = textoEstado(f);
  const barra = t.boton.querySelector('.progreso');
  barra.hidden = f.estado !== 'haciendo';
  barra.firstElementChild.style.width = f.pasos ? `${(f.paso / f.pasos) * 100}%` : '3%';
  t.boton.querySelector('.info').textContent = f.estado === 'haciendo'
    ? `falta ${textoTiempo(faltaFoto(f, datos))}`
    : `${f.tipo} · ${f.origen}`;
  // La imagen solo se recarga cuando cambia de estado, para que no parpadee
  if (t.estado !== f.estado || t.tipo !== f.tipo) {
    const cual = f.estado === 'lista' ? 'resultado' : 'original';
    t.boton.querySelector('img').src = `/api/salas/${sala}/fotos/${f.id}/${cual}?v=${f.fin}`;
    t.estado = f.estado;
    t.tipo = f.tipo;
  }
}

function pintar(datos) {
  ultimo = datos;
  const ids = new Set(datos.fotos.map(f => f.id));
  for (const [id, t] of tarjetas) if (!ids.has(id)) { t.boton.remove(); tarjetas.delete(id); }
  for (const f of datos.fotos) {
    if (!tarjetas.has(f.id)) tarjetas.set(f.id, crearTarjeta(f));
    pintarTarjeta(tarjetas.get(f.id), f, datos);
  }
  vacio.hidden = datos.fotos.length > 0;

  const listas = datos.fotos.filter(f => f.estado === 'lista').length;
  const total = datos.fotos.length;
  document.getElementById('cuenta').textContent = `${listas} de ${total}`;
  document.getElementById('barra-total').style.width = total ? `${(listas / total) * 100}%` : '0';
  // Con varios motores la fila se reparte entre ellos
  const falta = datos.fotos.reduce((s, f) => s + faltaFoto(f, datos), 0) / Math.max(1, datos.motores || 1);
  document.getElementById('falta').textContent = falta > 0
    ? `Faltan unos ${textoTiempo(falta)} (≈ ${textoTiempo(datos.segundos_por_foto)} por foto)`
    : '';

  const motor = document.getElementById('motor');
  motor.className = `motor ${datos.motor_conectado ? 'encendido' : 'apagado'}`;
  motor.textContent = !datos.motor_conectado ? 'Motor apagado'
    : datos.motores > 1 ? `${datos.motores} motores conectados` : 'Motor conectado';
  motor.title = datos.motor_conectado ? '' : 'Abre el cuaderno de Colab o Kaggle y corre el paso 8';

  if (abierta !== null) pintarDetalle();
}

async function actualizar() {
  try {
    pintar(await api(''));
  } catch (error) {
    document.getElementById('falta').textContent = error.message;
  }
  setTimeout(actualizar, 1500);
}

// ---------- Subir desde la PC ----------
const dialogoSubida = document.getElementById('subida');
const archivo = document.getElementById('archivo');
const errorSubida = document.getElementById('error-subida');
document.getElementById('subir').addEventListener('click', () => { errorSubida.textContent = ''; dialogoSubida.showModal(); });
document.querySelectorAll('[data-tipo-subida]').forEach(b => b.addEventListener('click', () => {
  tipoSubida = b.dataset.tipoSubida;
  document.querySelectorAll('[data-tipo-subida]').forEach(x => x.setAttribute('aria-pressed', x === b));
}));
document.getElementById('elegir-archivos').addEventListener('click', () => {
  if (!document.getElementById('mayor-pc').checked) {
    errorSubida.textContent = 'Marca la casilla: solo se procesan fotos de mayores de 18 años.';
    return;
  }
  archivo.click();
});
archivo.addEventListener('change', async () => {
  const lista = [...archivo.files];
  archivo.value = '';
  let fallidas = 0;
  for (const a of lista) {
    errorSubida.textContent = `Subiendo ${lista.indexOf(a) + 1} de ${lista.length}…`;
    try { await subirFoto(a, tipoSubida, 'PC'); } catch (e) { fallidas += 1; }
  }
  if (fallidas) errorSubida.textContent = `${fallidas} foto(s) no se pudieron subir. Revisa que sean JPG o PNG.`;
  else dialogoSubida.close();
});

// ---------- Detalle de una foto ----------
const detalle = document.getElementById('detalle');
const escena = document.getElementById('escena');
let escenaDe = '';

function abrirDetalle(id) {
  abierta = id;
  escenaDe = '';
  const f = ultimo.fotos.find(x => x.id === id);
  tipoRepetir = f.tipo;
  document.getElementById('detalle-error').textContent = '';
  pintarDetalle();
  detalle.showModal();
}

function pintarDetalle() {
  const f = ultimo.fotos.find(x => x.id === abierta);
  if (!f) { detalle.close(); abierta = null; return; }
  document.getElementById('detalle-titulo').textContent = `Foto ${f.id} · uniforme de ${f.tipo} · desde ${f.origen === 'PC' ? 'la PC' : 'el celular'}`;
  const base = `/api/salas/${sala}/fotos/${f.id}`;
  const clave = `${f.estado}-${f.fin}`;
  if (escenaDe !== clave) {
    escenaDe = clave;
    if (f.estado === 'lista') {
      escena.innerHTML = `<div class="comparador" tabindex="0" aria-label="Arrastra para comparar antes y después">
        <img src="${base}/original" alt="Antes"><img class="despues" src="${base}/resultado?v=${f.fin}" alt="Con uniforme">
        <span class="etq izq">Antes</span><span class="etq der">Con uniforme</span>
        <span class="linea"></span><span class="tirador"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 3 12 9 6"/><polyline points="15 6 21 12 15 18"/></svg></span></div>`;
      activarComparador(escena.firstElementChild);
    } else {
      escena.innerHTML = `<div class="foto-sola"><img src="${base}/original" alt="Foto recibida">
        <div class="aviso-avance" hidden><span></span><div class="progreso"><i></i></div></div></div>`;
    }
  }
  const aviso = escena.querySelector('.aviso-avance');
  if (aviso) {
    aviso.hidden = f.estado === 'error';
    const texto = f.estado === 'cola'
      ? `En espera · ${ultimo.fotos.filter(x => x.estado === 'cola' && x.creada < f.creada).length} foto(s) antes`
      : `Poniendo el uniforme · paso ${f.paso} de ${f.pasos || '…'} · falta ${textoTiempo(faltaFoto(f, ultimo))}`;
    aviso.querySelector('span').textContent = texto;
    aviso.querySelector('i').style.width = f.pasos ? `${(f.paso / f.pasos) * 100}%` : '0';
  }
  if (f.estado === 'error') document.getElementById('detalle-error').textContent = f.error;
  const descargar = document.getElementById('descargar');
  descargar.hidden = f.estado !== 'lista';
  descargar.href = `${base}/resultado`;
  descargar.download = `uniforme_${f.id}.jpg`;
  document.getElementById('repetir').disabled = f.estado === 'haciendo';
  document.querySelectorAll('[data-repetir]').forEach(b => b.setAttribute('aria-pressed', b.dataset.repetir === tipoRepetir));
}

document.querySelectorAll('[data-repetir]').forEach(b => b.addEventListener('click', () => { tipoRepetir = b.dataset.repetir; pintarDetalle(); }));
document.getElementById('cerrar').addEventListener('click', () => detalle.close());
detalle.addEventListener('close', () => { abierta = null; });
document.getElementById('repetir').addEventListener('click', async () => {
  const datos = new FormData();
  datos.append('tipo', tipoRepetir);
  try { await api(`/fotos/${abierta}/repetir`, { method: 'POST', body: datos }); }
  catch (e) { document.getElementById('detalle-error').textContent = e.message; }
});
document.getElementById('borrar').addEventListener('click', async () => {
  const id = abierta;
  detalle.close();
  await api(`/fotos/${id}`, { method: 'DELETE' }).catch(() => {});
});
document.getElementById('borrar-todo').addEventListener('click', async () => {
  const boton = document.getElementById('borrar-todo');
  if (boton.dataset.seguro !== 'si') {
    boton.dataset.seguro = 'si';
    boton.textContent = 'Toca otra vez para borrar todo';
    setTimeout(() => { boton.dataset.seguro = ''; boton.textContent = 'Borrar todas las fotos'; }, 4000);
    return;
  }
  await api('', { method: 'DELETE' }).catch(() => {});
  location.href = '/';
});

actualizar();
