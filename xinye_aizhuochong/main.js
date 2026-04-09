const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('path');

app.setAppUserModelId('com.xinye.pet');
let win;

app.whenReady().then(() => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 620,
    height: 420,
    x: width - 650,
    y: height - 450,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, 'xinye.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile('pet.html');
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true }); // 透明区域点击穿透

  // 手动拖动窗口（替代 -webkit-app-region:drag，避免右键被系统菜单拦截）
  ipcMain.on('win-drag-move', (e, { dx, dy }) => {
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  });

  // 自定义右键菜单
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

  // 面板在窗口内显示，不再扩大窗口（扩大会导致角色闪跳）

  // 防止 Electron 自己弹 webContents 右键菜单
  win.webContents.on('context-menu', (e) => e.preventDefault());
});

app.on('window-all-closed', () => app.quit());
