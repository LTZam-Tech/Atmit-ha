// page transitions like many marketing sites (Barba / swup): the address changes at once, the content 1.5 s later
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-swap]');
  if (!a) return;
  e.preventDefault();
  history.pushState({}, '', a.href);
  document.body.style.opacity = '0.6';
  setTimeout(async () => {
    const html = await (await fetch(a.href)).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    document.body.style.opacity = '1';
  }, 1500);
});
