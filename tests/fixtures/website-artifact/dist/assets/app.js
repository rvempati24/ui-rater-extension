const app = document.querySelector('#app');
function render() { app.textContent = location.pathname === '/deep-route' ? 'deep route' : 'home'; }
document.querySelector('#deep-link')?.addEventListener('click', (event) => {
  event.preventDefault(); history.pushState({}, '', '/deep-route'); render();
});
addEventListener('popstate', render); render();
