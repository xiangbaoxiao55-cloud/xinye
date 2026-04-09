const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('path');

app.setAppUserModelId('com.choubao.pet');
let win;

app.whenReady().then(() => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 460,
    height: 390,
    x: width - 980,   // 炘也在右下，臭宝在它左边
    y: height - 420,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, '..', 'xinye.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile('pet.html');
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });

  ipcMain.on('win-drag-move', (e, { dx, dy }) => {
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  });

  const buildMenu = () => Menu.buildFromTemplate([
    { label: '⚙️ 设置', click: () => win.webContents.send('open-settings') },
    { label: '💬 聊天记录', click: () => win.webContents.send('open-history') },
    { type: 'separator' },
    { label: '📌 取消置顶', click: () => { win.setAlwaysOnTop(false); } },
    { label: '📌 恢复置顶', click: () => { win.setAlwaysOnTop(true, 'floating'); } },
    { type: 'separator' },
    { label: '🚪 退出', click: () => app.quit() },
  ]);

  ipcMain.on('show-context-menu', () => buildMenu().popup({ window: win }));
  ipcMain.on('set-ignore-mouse', (e, ignore) => {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  });

  win.webContents.on('context-menu', (e) => e.preventDefault());
});

app.on('window-all-closed', () => app.quit());
