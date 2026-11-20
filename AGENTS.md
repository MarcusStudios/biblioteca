# Regras do Projeto — Biblioteca do Convento

- **Versionamento no rodapé e cache-busting:** toda vez que uma grande alteração (nova funcionalidade, mudança visual relevante ou correção importante) for concluída em `index.html`, `css/styles.css` ou `js/app.js`, atualize a versão exibida nos dois rodapés de `index.html` (`<p class="login-foot">...Versão X.Y.Z</p>` e `<span id="appVersion">Versão X.Y.Z</span>`) e atualize também a query `?v=X.Y.Z` nos links de `css/styles.css` e `js/app.js` (e `config/keys.js`, quando alterado) para evitar cache antigo no navegador.
