// Marks the page as the Windows app (the same page `npm start` serves in a browser).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('frostTraderDesktop', { platform: process.platform });
