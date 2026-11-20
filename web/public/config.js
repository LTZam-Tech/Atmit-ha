// Runtime settings of the web app. In the container image this file is rewritten at start from environment
// variables (docker/05-atimtha-config.envsh); during development it stays empty and src/environments/*.ts decide.
window.__ATIMTHA_CONFIG__ = window.__ATIMTHA_CONFIG__ || {};
