// Tablero del encargado: muestra las fotos de la sala y se actualiza cada 1,5 s.
const rejilla = document.getElementById('rejilla');
const vacio = document.getElementById('vacio');
const tarjetas = new Map();
let ultimo = null;
let abierta = null;
let tipoSubida = 'chica';
let iaSubida = null;
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

let geminiTrabajando = null;
const textoEstado = f => ({
  cola: 'En espera',
  gemini: geminiTrabajando === f.id ? 'Gemini trabajando…' : 'Espera Gemini',
  haciendo: f.pasos ? `Poniendo ${Math.round((f.paso / f.pasos) * 100)}%` : 'Empezando…',
  lista: 'Lista',
  error: 'No se pudo',
}[f.estado]);

function faltaFoto(f, datos) {
  if (f.estado === 'cola') return datos.segundos_por_foto;
  if (f.estado === 'gemini') return SEGUNDOS_GEMINI;
  if (f.estado !== 'haciendo') return 0;
  const pasado = datos.ahora - f.inicio;
  if (f.paso > 0) return ((f.pasos - f.paso) * pasado) / f.paso + 3;
  return Math.max(5, datos.segundos_por_foto - pasado);
}

const iconoTacho = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

function crearTarjeta(f) {
  const boton = document.createElement('div');
  boton.className = 'tarjeta';
  boton.innerHTML = `<button class="abrir"><div class="img"><img alt="" loading="lazy"><span class="chip"></span>
      <div class="progreso" hidden><i></i></div></div>
    <div class="datos"><b>Foto ${f.id}</b><span class="info"></span></div></button>
    <button class="tacho" aria-label="Borrar foto ${f.id}" title="Borrar foto">${iconoTacho}</button>`;
  boton.querySelector('img').src = `/api/salas/${sala}/fotos/${f.id}/original`;
  boton.querySelector('.abrir').addEventListener('click', () => abrirDetalle(f.id));
  const tacho = boton.querySelector('.tacho');
  // Primer toque pide confirmar, el segundo borra: así no se borra por un roce
  tacho.addEventListener('click', async () => {
    if (!tacho.classList.contains('seguro')) {
      tacho.classList.add('seguro');
      tacho.innerHTML = `${iconoTacho}<span>¿Borrar?</span>`;
      setTimeout(() => { tacho.classList.remove('seguro'); tacho.innerHTML = iconoTacho; }, 3000);
      return;
    }
    boton.classList.add('borrando');
    await api(`/fotos/${f.id}`, { method: 'DELETE' }).catch(() => {});
    boton.remove();
    tarjetas.delete(f.id);
  });
  rejilla.prepend(boton);
  return { boton, estado: null, tipo: null };
}

function pintarTarjeta(t, f, datos) {
  const chip = t.boton.querySelector('.chip');
  chip.className = `chip ${f.estado === 'gemini' ? 'espera-gemini' : f.estado}`;
  chip.textContent = textoEstado(f);
  const barra = t.boton.querySelector('.progreso');
  barra.hidden = f.estado !== 'haciendo';
  barra.firstElementChild.style.width = f.pasos ? `${(f.paso / f.pasos) * 100}%` : '3%';
  t.boton.querySelector('.info').textContent = f.estado === 'haciendo'
    ? `falta ${textoTiempo(faltaFoto(f, datos))}`
    : `${f.tipo} · ${f.origen}${f.ia === 'gemini' ? ' · Gemini' : ''}`;
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

  pintarIa(datos);
  pintarNube(datos.nube);
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
const botonSubirLista = document.getElementById('elegir-archivos');
const suelta = document.getElementById('suelta');
const miniaturas = document.getElementById('miniaturas');
let porSubir = [];

function revisarSubida() {
  botonSubirLista.disabled = !(porSubir.length && iaSubida && document.getElementById('mayor-pc').checked);
  botonSubirLista.textContent = porSubir.length ? `Subir ${porSubir.length} foto${porSubir.length > 1 ? 's' : ''}` : 'Subir fotos';
}

function pintarMiniaturas() {
  miniaturas.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src));
  miniaturas.innerHTML = '';
  porSubir.forEach((a, i) => {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img alt="Foto ${i + 1}"><button type="button" class="quitar" aria-label="Quitar foto ${i + 1}">×</button>`;
    fig.querySelector('img').src = URL.createObjectURL(a);
    fig.querySelector('.quitar').addEventListener('click', () => { porSubir.splice(i, 1); pintarMiniaturas(); });
    miniaturas.append(fig);
  });
  miniaturas.hidden = !porSubir.length;
  revisarSubida();
}

function agregarFotos(lista) {
  const fotos = [...lista].filter(a => a.type.startsWith('image/'));
  if (fotos.length < lista.length) errorSubida.textContent = 'Algunos archivos no eran fotos y no se agregaron.';
  porSubir.push(...fotos);
  pintarMiniaturas();
}

document.getElementById('subir').addEventListener('click', () => {
  errorSubida.textContent = '';
  porSubir = [];
  pintarMiniaturas();
  dialogoSubida.showModal();
});
suelta.addEventListener('click', () => archivo.click());
['dragenter', 'dragover'].forEach(ev => dialogoSubida.addEventListener(ev, e => { e.preventDefault(); suelta.classList.add('encima'); }));
['dragleave', 'drop'].forEach(ev => dialogoSubida.addEventListener(ev, e => { e.preventDefault(); suelta.classList.remove('encima'); }));
dialogoSubida.addEventListener('drop', e => agregarFotos(e.dataTransfer.files));
document.getElementById('mayor-pc').addEventListener('change', revisarSubida);
document.querySelectorAll('[data-tipo-subida]').forEach(b => b.addEventListener('click', () => {
  tipoSubida = b.dataset.tipoSubida;
  document.querySelectorAll('[data-tipo-subida]').forEach(x => x.setAttribute('aria-pressed', x === b));
}));
document.querySelectorAll('[data-ia-subida]').forEach(b => b.addEventListener('click', () => {
  iaSubida = b.dataset.iaSubida;
  document.querySelectorAll('[data-ia-subida]').forEach(x => x.setAttribute('aria-pressed', x === b));
  revisarSubida();
}));
archivo.addEventListener('change', () => {
  agregarFotos(archivo.files);
  archivo.value = '';
});
botonSubirLista.addEventListener('click', async () => {
  const lista = porSubir;
  botonSubirLista.disabled = true;
  const fallidas = [];
  for (const [i, a] of lista.entries()) {
    errorSubida.textContent = `Subiendo ${i + 1} de ${lista.length}…`;
    try { await subirFoto(a, tipoSubida, 'PC', iaSubida); } catch (e) { fallidas.push(a); }
  }
  // Las que fallaron quedan en la lista para reintentar
  porSubir = fallidas;
  pintarMiniaturas();
  if (fallidas.length) errorSubida.textContent = `${fallidas.length} foto(s) no se pudieron subir. Revisa que sean JPG o PNG y vuelve a intentar.`;
  else { errorSubida.textContent = ''; dialogoSubida.close(); }
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
  avisoGemini('');
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
    const texto = f.estado === 'gemini'
      ? (geminiTrabajando === f.id ? 'Gemini está poniendo el uniforme…' : 'Espera su turno con Gemini')
      : f.estado === 'cola'
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
  document.querySelectorAll('[data-repetir-ia]').forEach(b => { b.disabled = f.estado === 'haciendo' || geminiTrabajando === f.id; });
  document.querySelectorAll('[data-repetir]').forEach(b => b.setAttribute('aria-pressed', b.dataset.repetir === tipoRepetir));
}

document.querySelectorAll('[data-repetir]').forEach(b => b.addEventListener('click', () => { tipoRepetir = b.dataset.repetir; pintarDetalle(); }));
document.getElementById('cerrar').addEventListener('click', () => detalle.close());
detalle.addEventListener('close', () => { abierta = null; });
// R3: un botón por IA. La foto vuelve a la fila de la IA elegida y el resultado nuevo reemplaza al anterior.
document.querySelectorAll('[data-repetir-ia]').forEach(b => b.addEventListener('click', async () => {
  const ia = b.dataset.repetirIa;
  const datos = new FormData();
  datos.append('tipo', tipoRepetir);
  datos.append('ia', ia);
  document.getElementById('detalle-error').textContent = '';
  try {
    await api(`/fotos/${abierta}/repetir`, { method: 'POST', body: datos });
    if (ia === 'gemini' && !conSesion()) {
      avisoGemini('Inicia sesión en Puter en la ventana que se abrió…');
      await iniciarSesion();
    }
    avisoGemini(ia === 'gemini' ? 'En la fila de Gemini: se hace sola en unos segundos.' : 'En la fila de Colab.', 'ok');
  } catch (e) {
    document.getElementById('detalle-error').textContent = e.message || textoErrorPuter(e);
  }
}));
document.getElementById('borrar').addEventListener('click', async () => {
  const id = abierta;
  detalle.close();
  await api(`/fotos/${id}`, { method: 'DELETE' }).catch(() => {});
});
// ---------- Gemini por Puter (se hace en este navegador) ----------
const PEDIDO_GEMINI = 'Edit the first photo: dress the person in exactly the outfit shown in the second image '
  + '(same blazer, white shirt, tie with its logo, trousers and black shoes, same colors and details). '
  + 'Keep the face, hair, skin, body shape, pose, hands, background, lighting, camera angle and framing of the first photo exactly the same. '
  + 'Photorealistic, natural fit and folds. Return only the edited photo.';
const SEGUNDOS_GEMINI = 30;
const estadoGemini = document.getElementById('gemini-estado');
const entrarPuter = document.getElementById('entrar-puter');
let geminiSinCuenta = false;

function avisoGemini(texto, clase = '') { estadoGemini.textContent = texto; estadoGemini.className = `gemini-estado ${clase}`; }

function textoDeError(error) {
  return typeof error === 'string' ? error : JSON.stringify(error?.error || error?.message || error || '');
}

const sinSaldo = error => /insufficient|funds|credit|balance|limit|quota|usage/i.test(textoDeError(error));
const conSesion = () => Boolean(window.puter && puter.auth.isSignedIn());

function textoErrorPuter(error) {
  const texto = textoDeError(error);
  if (sinSaldo(error)) return 'Se acabó el saldo gratis de esta cuenta de Puter. Entra con otra cuenta.';
  if (/safety|policy|blocked|prohibit/i.test(texto)) return 'Gemini no quiso hacer esta foto. Toma otra de frente y con buena luz.';
  if (/cancel|closed|popup/i.test(texto)) return 'No se inició sesión en Puter.';
  return `Gemini falló: ${texto.slice(0, 160)}`;
}

async function comoBlob(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`No se pudo leer ${url}`);
  return r.blob();
}

// Saldo gratis del mes de la cuenta de Puter (en microcentavos: 1 dólar = 100 000 000).
// Puter no cobra: cuando el saldo se acaba, deja de responder. Igual la página para antes de intentarlo.
const saldo = { restante: null, total: null, costoFoto: Number(localStorage.getItem('costoFotoGemini')) || null };

async function leerSaldo() {
  if (!conSesion() || !puter.auth.getMonthlyUsage) return;
  try {
    const info = (await puter.auth.getMonthlyUsage())?.allowanceInfo;
    if (info) { saldo.restante = info.remaining; saldo.total = info.monthUsageAllowance; }
  } catch (e) { /* si no responde, se deja el último valor */ }
  pintarSaldo();
}

let saldoPreguntando = false;

function pintarSaldo() {
  const caja = document.getElementById('saldo-gemini');
  if (saldoPreguntando) return;
  caja.hidden = !conSesion() || saldo.restante === null;
  if (caja.hidden) return;
  const porcentaje = saldo.total ? Math.max(0, Math.round((saldo.restante / saldo.total) * 100)) : 0;
  const alcanza = saldo.costoFoto ? Math.max(0, Math.floor(saldo.restante / saldo.costoFoto)) : null;
  const sinSaldoYa = porcentaje <= 0 || alcanza === 0;
  caja.className = `saldo ${sinSaldoYa ? 'sin' : (porcentaje <= 30 || (alcanza !== null && alcanza <= 2)) ? 'poco' : ''}`;
  caja.textContent = sinSaldoYa ? 'Gemini sin saldo en esta cuenta'
    : `Saldo Gemini ${porcentaje}%${alcanza !== null ? ` · alcanza para ~${alcanza} foto${alcanza === 1 ? '' : 's'}` : ''}`;
  caja.title = 'Saldo gratis del mes de esta cuenta de Puter. No cobra: cuando se acaba, la página se detiene y pide otra cuenta. Toca para cambiar de cuenta.';
}

// Tocar el saldo: el primer toque pregunta, el segundo cierra la sesión y abre Puter para entrar con otra cuenta
document.getElementById('saldo-gemini').addEventListener('click', async () => {
  const caja = document.getElementById('saldo-gemini');
  if (!saldoPreguntando) {
    saldoPreguntando = true;
    caja.className = 'saldo cambiar';
    caja.textContent = 'Cerrar esta cuenta y entrar con otra · toca otra vez';
    setTimeout(() => { saldoPreguntando = false; pintarSaldo(); }, 4000);
    return;
  }
  saldoPreguntando = false;
  try {
    if (conSesion()) await puter.auth.signOut();
    saldo.restante = null;
    pintarSaldo();
    await iniciarSesion();
  } catch (error) {
    document.getElementById('falta').textContent = textoErrorPuter(error);
  }
});

// Pone el uniforme con Gemini y guarda el resultado en la sala. Lanza el error de Puter si falla.
async function hacerConGemini(id, tipo) {
  await leerSaldo();
  const antes = saldo.restante;
  if (antes !== null && (antes <= 0 || (saldo.costoFoto && antes < saldo.costoFoto))) {
    throw new Error('insufficient funds: saldo gratis agotado (la página no lo intenta para no gastar)');
  }
  const [persona, uniforme] = await Promise.all([
    comoBlob(`/api/salas/${sala}/fotos/${id}/original`),
    comoBlob(`/estatico/uniforme_${tipo === 'chico' ? 'hombre' : 'mujer'}.webp`),
  ]);
  const imagen = await puter.ai.txt2img(PEDIDO_GEMINI, { model: 'gemini-3.1-flash-image', input_images: [persona, uniforme] });
  const datos = new FormData();
  datos.append('imagen', await comoBlob(imagen.src), 'gemini.png');
  await api(`/fotos/${id}/resultado-gemini`, { method: 'POST', body: datos });
  await leerSaldo();
  // Lo que costó esta foto sirve para avisar cuántas más alcanzan
  if (antes !== null && saldo.restante !== null && antes > saldo.restante) {
    const costo = antes - saldo.restante;
    saldo.costoFoto = saldo.costoFoto ? saldo.costoFoto * 0.5 + costo * 0.5 : costo;
    localStorage.setItem('costoFotoGemini', String(Math.round(saldo.costoFoto)));
    pintarSaldo();
  }
}

// Cuando se acaba el saldo: cierra la sesión y pide entrar con otra cuenta (el navegador exige un toque)
async function cuentaGastada() {
  try { await puter.auth.signOut(); } catch (e) { /* ya estaba cerrada */ }
  geminiSinCuenta = true;
  saldo.restante = null;
  pintarSaldo();
  entrarPuter.textContent = 'Entrar con otra cuenta de Puter';
}

async function iniciarSesion() {
  if (!window.puter) throw new Error('Puter no cargó. Revisa el internet y recarga la página.');
  if (!conSesion()) await puter.auth.signIn();
  geminiSinCuenta = false;
  entrarPuter.textContent = 'Entrar a Puter';
  leerSaldo();
}

// Modo Gemini: el tablero hace las fotos en espera una por una mientras haya sesión abierta
async function cicloGemini(datos) {
  if (geminiTrabajando !== null || !conSesion()) return;
  const f = datos.fotos.filter(x => x.estado === 'gemini').sort((a, b) => a.creada - b.creada)[0];
  if (!f) return;
  geminiTrabajando = f.id;
  try {
    await hacerConGemini(f.id, f.tipo);
  } catch (error) {
    console.log(error);
    if (sinSaldo(error)) {
      await cuentaGastada();
    } else {
      const datosError = new FormData();
      datosError.append('error', textoErrorPuter(error));
      await api(`/fotos/${f.id}/resultado-gemini`, { method: 'POST', body: datosError }).catch(() => {});
    }
  } finally {
    geminiTrabajando = null;
  }
}

// Copia en la nube (Cloudinary): si falla el internet, el servidor sigue y reintenta solo
function pintarNube(nube) {
  const caja = document.getElementById('nube');
  caja.hidden = !nube?.activa;
  if (caja.hidden) return;
  if (nube.fallando) {
    caja.className = 'nube fallando';
    caja.textContent = `Sin conexión con la nube: reintentando solo (${nube.pendientes} por guardar). Las fotos siguen aquí.`;
  } else if (nube.pendientes > 0) {
    caja.className = 'nube guardando';
    caja.textContent = `Guardando en la nube… (${nube.pendientes})`;
  } else {
    caja.className = 'nube';
    caja.textContent = 'Fotos guardadas en la nube';
  }
}

function pintarIa(datos) {
  const esperanGemini = datos.fotos.some(f => f.estado === 'gemini');
  entrarPuter.hidden = !esperanGemini || conSesion();
  if (esperanGemini && !conSesion()) {
    document.getElementById('falta').textContent = geminiSinCuenta
      ? 'Se acabó el saldo de esa cuenta: toca «Entrar con otra cuenta de Puter».'
      : 'Toca «Entrar a Puter» para que Gemini empiece.';
  }
  cicloGemini(datos);
}

entrarPuter.addEventListener('click', async () => {
  try { await iniciarSesion(); } catch (error) { document.getElementById('falta').textContent = textoErrorPuter(error); }
});

document.getElementById('gemini-cuenta').addEventListener('click', async () => {
  if (!window.puter) { avisoGemini('Puter no cargó. Revisa el internet y recarga la página.', 'mal'); return; }
  try {
    if (conSesion()) await puter.auth.signOut();
    await iniciarSesion();
    avisoGemini('Cuenta cambiada. Ya puedes probar con Gemini.', 'ok');
  } catch (error) {
    avisoGemini(textoErrorPuter(error), 'mal');
  }
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
window.addEventListener('load', () => leerSaldo());
