(() => {
  const storedTheme = localStorage.getItem('personal-agent-theme');
  const theme = storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : 'light';
  document.documentElement.dataset.theme = theme;
})();
