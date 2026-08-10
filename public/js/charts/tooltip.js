/**
 * Tek paylasilan ipucu balonu.
 *
 * Kural: ipucu bir degeri okumanin TEK yolu olamaz. Buradaki her sayi ayrica
 * tabloda da var — ipucu yalnizca hizlandirici.
 */

/** @type {HTMLDivElement|null} */
let el = null;

function ensure() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'tip';
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  return el;
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {string} html
 */
export function showTip(clientX, clientY, html) {
  const t = ensure();
  t.innerHTML = html;
  t.classList.add('show');

  // Once olc, sonra kenarlara sigdir.
  const r = t.getBoundingClientRect();
  const pad = 12;
  let x = clientX + 14;
  let y = clientY + 14;
  if (x + r.width + pad > window.innerWidth) x = clientX - r.width - 14;
  if (y + r.height + pad > window.innerHeight) y = clientY - r.height - 14;
  t.style.left = `${Math.max(pad, x)}px`;
  t.style.top = `${Math.max(pad, y)}px`;
}

export function hideTip() {
  el?.classList.remove('show');
}

/**
 * Bir SVG dugumune ipucu davranisi baglar. Klavye odagi da ayni bilgiyi verir.
 * @param {SVGElement} node
 * @param {() => string} render
 */
export function bindTip(node, render) {
  const show = (ev) => {
    const p = ev.touches?.[0] ?? ev;
    showTip(p.clientX, p.clientY, render());
  };
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', show);
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, render());
  });
  node.addEventListener('blur', hideTip);
}
