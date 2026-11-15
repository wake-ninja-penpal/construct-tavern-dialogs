'use client';

/**
 * Ветви — клиент realtime-коллаборации (этап 3 порта).
 *
 * Порт модуля «realtime-коллаборация» классической версии (index.html,
 * строки ~11450–12660): комнаты на сервере vetvi-sync (socket.io, порт 3003
 * через XTransformPort), снапшот-синхронизация состояния, presence, живые
 * перетаскивания (ноды/группы/изгибы/ширина диалога), soft-локи объектов с
 * откатом проигранной гонки, фокус участников («перейти к ноде»), пароль
 * проекта (salt+sha256, синхронизация в комнату), локальные копии с режимом
 * редактирования и merge-запросами (mailbox на сервере, бэкап перед merge).
 *
 * UI-состояние живёт в стору (syncStatus/syncUsers/syncLocks/…), сетевая
 * логика — здесь. Совместимо с классической версией: тот же сервер,
 * те же события и ключи localStorage.
 */

import { io, type Socket } from 'socket.io-client';

import { uid } from '@/vetvi/core/factory';
import { getMe, setMeName } from '@/vetvi/core/identity';
import { mergeDocs, mergeStats, type MergeStats } from '@/vetvi/core/merge';
import { passRandomSalt, sha256hex } from '@/vetvi/core/passlock';
import { projReadSlot } from '@/vetvi/core/projects';
import { stItem, stSetItem } from '@/vetvi/core/storage';
import type { VetviEdge, VetviGroup, VetviNode } from '@/vetvi/core/types';
import { canvasApi } from './canvasApi';
import type { VetviStore } from './store';

const LS_COPIES = 'vetvi-copies-v1';
const LS_BACKUPS = 'vetvi-backups-v1';
const SYNC_URL = '/?XTransformPort=3003';

export interface SyncCopy {
  copyId: string;
  name: string;
  createdAt: string;
  editedAt: string;
  sourceRoomId: string | null;
  sourceProjectId: string | null;
  state: Record<string, unknown>;
  base: Record<string, unknown>;
  lastMergeId?: string | null;
  lastMergeStatus?: string | null;
}

interface LockInfo { id: string; name: string; color: string }

type IdObjList = { id?: string; type?: string; dialog?: unknown; notes?: unknown }[];

interface JoinOpts {
  silent?: boolean;
  own?: boolean;
  pushLocal?: boolean;
  password?: string;
  /* подключение по ссылке из хэша (#room=…&project=…): проект ссылки, совпадающий
     с проектом комнаты, открывается из комнаты без диалога — как переход по ссылке */
  viaLink?: boolean;
  _pwWrong?: boolean;
}

interface SyncDoc {
  app?: string;
  meta?: Record<string, unknown>;
  nodes?: VetviNode[];
  edges?: VetviEdge[];
  groups?: VetviGroup[];
  [k: string]: unknown;
}

function copiesAll(): SyncCopy[] {
  try {
    return JSON.parse(stItem(LS_COPIES) || '[]') as SyncCopy[];
  } catch {
    return [];
  }
}

function backupsRead(): { id: string; at: string; label: string; doc: Record<string, unknown> }[] {
  try {
    return JSON.parse(stItem(LS_BACKUPS) || '[]') as { id: string; at: string; label: string; doc: Record<string, unknown> }[];
  } catch {
    return [];
  }
}

export function syncFmtDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export { copiesAll };

export class SyncClient {
  enabled = false;
  room: string | null = null;
  projectId: string | null = null;
  sock: Socket | null = null;
  status: 'off' | 'conn' | 'on' | 'err' | 'lost' = 'off';
  applyingRemote = false;
  pendingRemote: SyncDoc | null = null;
  /* когда пришёл отложенный снимок — локальные сдвиги позже него не перезаписываются */
  pendingRemoteAt = 0;
  /* разовая явная публикация чужого проекта в комнату (кнопка «Опубликовать мою») */
  allowForeignOnce = false;
  joinPass: string | null = null;
  stateT: ReturnType<typeof setTimeout> | null = null;
  lastSent = '';
  liveT = 0;
  liveDlgT = 0;
  livePtsT = 0;
  mode: 'local' | 'room' | 'copy' = 'local';
  activeCopy: string | null = null;
  mergeCount = 0;
  rlocks: Record<string, LockInfo> | null = null;
  myLocks: Record<string, number> = {};
  lockHB: ReturnType<typeof setInterval> | null = null;
  myFocus: string | null = null;
  focusSent: string | null = null;
  opSock: Socket | null = null;
  /* ожидание пароля комнаты (окно roomPass) */
  pwPending: { roomId: string; pid: string | null; opts: JoinOpts; wrong: boolean } | null = null;
  private pollT: ReturnType<typeof setInterval> | null = null;

  constructor(private store: VetviStore) {}

  /* ═══ хэш ссылки: #room=<id>&project=<pid> ═══ */

  hashParams(): Record<string, string> {
    let h = '';
    try {
      const top = (window as unknown as { top?: { location?: { hash?: string } } }).top;
      if (top && top.location) h = top.location.hash || '';
    } catch { /* cross-origin */ }
    if (!h) h = window.location.hash || '';
    const out: Record<string, string> = {};
    h.replace(/^#/, '').split('&').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
    });
    return out;
  }

  setHash(room: string | null, pid?: string | null): void {
    const h = room ? ('room=' + encodeURIComponent(room) + (pid ? '&project=' + encodeURIComponent(pid) : '')) : '';
    try {
      const top = (window as unknown as { top?: { location?: { hash?: string } } }).top;
      if (top && top.location) { top.location.hash = h; return; }
    } catch { /* cross-origin */ }
    window.location.hash = h;
  }

  shareUrl(): string {
    const p = this.hashParams();
    if (!p.room) return '';
    let base = '';
    try {
      const top = (window as unknown as { top?: { location?: { origin?: string; pathname?: string } } }).top;
      if (top && top.location) base = String(top.location.origin || '') + String(top.location.pathname || '');
    } catch { /* cross-origin */ }
    if (!base) base = window.location.origin + window.location.pathname;
    return base + '#room=' + encodeURIComponent(p.room) + (p.project ? '&project=' + encodeURIComponent(p.project) : '');
  }

  /* ═══ статусы и отрисовка чипа (данные читает TopBar) ═══ */

  private setStatus(s: 'off' | 'conn' | 'on' | 'err' | 'lost'): void {
    this.status = s;
    this.store.syncStatus = this.mode === 'copy' ? 'copy' : s;
    this.store.emit();
  }

  renderUI(): void {
    this.store.syncStatus = this.mode === 'copy' ? 'copy' : (this.enabled ? this.status : 'off');
    this.store.syncMode = this.mode;
    this.store.syncRoom = this.room;
    this.store.syncMergeCount = this.mergeCount;
    this.store.emit();
  }

  /* ═══ подключение к комнате ═══ */

  connect(roomId: string, pid: string | null, opts: JoinOpts = {}): void {
    if (this.sock) {
      try { this.sock.disconnect(); } catch { /* уже отвалился */ }
      this.sock = null;
    }
    this.enabled = true;
    this.room = roomId;
    this.projectId = pid || null;
    if (this.mode !== 'copy') this.mode = 'room';
    this.setStatus('conn');
    this.renderUI();

    const me = getMe();
    const sock = io(SYNC_URL, {
      path: '/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
    });
    this.sock = sock;

    sock.on('connect', () => {
      const jpay: Record<string, unknown> = { roomId, user: { id: me.id, name: me.name, color: me.color } };
      const jpw = (typeof opts.password === 'string' && opts.password) ? opts.password : (this.store.syncProjPass || this.joinPass || null);
      if (jpw) jpay.password = jpw;
      const meta = this.store.doc.meta as unknown as { passHash?: string; passSalt?: string };
      if (meta && meta.passHash) jpay.pass = { salt: String(meta.passSalt || ''), hash: String(meta.passHash) };
      sock.emit('vetvi:join', jpay, (res: { ok?: boolean; needPassword?: boolean; users?: { id: string; name: string; color: string }[]; locks?: LockInfo[]; focus?: { userId: string; nodeId: string }[]; pendingMerges?: number; doc?: SyncDoc } | null) => {
        if (!res || !res.ok) {
          if (res && res.needPassword) {
            if (jpw) opts._pwWrong = true;
            this.askRoomPassword(roomId, pid, opts);
            return;
          }
          this.setStatus('err');
          this.store.toast('Не удалось войти в комнату', 'err');
          return;
        }
        opts._pwWrong = false;
        this.setStatus('on');
        this.store.syncUsers = res.users || [];
        this.lockApplyServerList(res.locks);
        this.focusApply(res.focus);
        this.focusSent = null;
        this.focusEmit();
        if (!this.lockHB) this.lockHB = setInterval(() => this.lockHeartbeat(), 45000);
        this.mergeCount = this.mode === 'copy' ? 0 : (res.pendingMerges || 0);
        this.renderUI();

        const serverDoc = res.doc || null;
        let localJson = '';
        try { localJson = JSON.stringify(this.store.syncDocObj()); } catch { /* нет сериализации */ }
        let serverJson = '';
        try { serverJson = serverDoc ? JSON.stringify(serverDoc) : ''; } catch { /* нет сериализации */ }

        if (!serverDoc) {
          this.flushState(true);
          if (!opts.silent && !opts.own) this.store.toast('Комната открыта — отправьте ссылку соавторам');
        } else if (localJson === serverJson) {
          /* уже совпадаем */
        } else if (opts.pushLocal) {
          this.flushState(true);
        } else {
          const localEmpty = this.store.doc.nodes.length === 0;
          const roomPid = (serverDoc.meta && serverDoc.meta.projectId) ? String(serverDoc.meta.projectId) : null;
          const metaPid = this.store.doc.meta.projectId as string | undefined;
          /* своя комната без projectId в снимке — устаревший снимок этого же проекта */
          const sameProject = !!(roomPid && metaPid && roomPid === metaPid) || (!roomPid && opts.own === true);
          const serverModified = (serverDoc.meta && serverDoc.meta.modified) ? serverDoc.meta.modified : null;
          const localModified = this.store.doc.meta.modified;
          const serverNewer = !!(serverModified && localModified && (serverModified as number) >= (localModified as number));
          /* Есть ли данные ЭТОГО проекта локально (слот roomPid). Нет слота и локальный
             проект ещё ни разу не сохранялся (нет projectId) — проект открывается впервые:
             молча загружаем состояние комнаты, без модалки (projInitStartup оригинала 11414:
             чужой проект без данных слота грузится пустым → localEmpty → applyRemote). */
          const hasLocalSlotForRoom = !!(roomPid && projReadSlot(roomPid));
          const pristine = !metaPid; /* дефолтный «Без названия», ни одного автосохранения */
          /* Переход по ССЫЛКЕ проекта (#room=…&project=P): комната содержит именно этот
             проект, а локально открыт другой — открываем проект из комнаты, как «Открыть
             проект» (диалог «публикация/загрузка» здесь только путает: выбор не влияет
             на текущий документ и выглядит как «возврат в старый проект»). */
          const linkSwitch = !!(opts.viaLink && roomPid && this.projectId && roomPid === this.projectId && metaPid && roomPid !== metaPid);
          if (localEmpty || (!hasLocalSlotForRoom && pristine) || (sameProject && serverNewer)) {
            this.applyRemote(serverDoc, true, opts.own === true);
            this.store.toast('Загружено состояние из комнаты');
          } else if (linkSwitch) {
            this.applyRemote(serverDoc, true);
            this.store.toast('Открыт проект из комнаты по ссылке', 'ok');
          } else if (sameProject) {
            this.flushState(true);
            if (!opts.silent) this.store.toast('Локальная версия новее — опубликована в комнату', 'warn');
          } else {
            this.store.confirmBox({
              title: 'Комната уже содержит проект',
              text: 'В комнате уже есть общее состояние, а у вас открыт другой проект. Загрузить общий (текущая работа будет заменена) или опубликовать вашу локальную версию?',
              buttons: [
                { label: 'Опубликовать мою', fn: () => { this.allowForeignOnce = true; this.flushState(true); this.allowForeignOnce = false; } },
                { label: 'Загрузить из комнаты', primary: true, fn: () => this.applyRemote(serverDoc, true) },
              ],
            });
          }
        }
        if (this.mergeCount > 0) this.store.toast('Merge-запросов в очереди: ' + this.mergeCount, 'warn');
      });
    });
    sock.on('disconnect', () => { if (this.enabled) this.setStatus('lost'); });
    sock.io.on('reconnect', () => this.setStatus('conn'));
    sock.on('connect_error', () => this.setStatus('err'));
    sock.on('vetvi:users', (m: { roomId?: string; users?: { id: string; name: string; color: string }[] }) => {
      if (!m || m.roomId !== this.room) return;
      this.store.syncUsers = m.users || [];
      this.store.emit();
    });
    sock.on('vetvi:locks', (m: { roomId?: string; locks?: LockInfo[] }) => {
      if (!m || m.roomId !== this.room) return;
      this.lockApplyServerList(m.locks);
    });
    sock.on('vetvi:focus', (m: { roomId?: string; focus?: { userId: string; nodeId: string }[] }) => {
      if (!m || m.roomId !== this.room) return;
      this.focusApply(m.focus);
    });
    sock.on('vetvi:state', (m: { roomId?: string; doc?: SyncDoc }) => {
      if (!m || m.roomId !== this.room) return;
      this.handleRemoteDoc(m.doc);
    });
    sock.on('vetvi:live', (m: { roomId?: string; nodes?: { id: string; x: number; y: number }[]; groups?: { id: string; x: number; y: number }[]; pts?: { eid: string; pts: { x: number; y: number }[] }[]; dlgW?: { id: string; w: number }[] }) => {
      if (!m || m.roomId !== this.room) return;
      this.applyLive(m);
    });
    sock.on('vetvi:merge-new', (m: { roomId?: string; sender?: { name?: string } }) => {
      if (!m || m.roomId !== this.room) return;
      this.mergeCount = (this.mergeCount || 0) + 1;
      this.renderUI();
      this.store.toast('Новый merge-запрос от ' + ((m.sender && m.sender.name) || 'гостя'), 'warn');
    });
    sock.on('vetvi:merge-decision', (m: { roomId?: string; copyId?: string; status?: string }) => {
      if (!m) return;
      const list = copiesAll();
      let hit = false;
      list.forEach((c) => { if (m.copyId && c.copyId === m.copyId) { c.lastMergeStatus = m.status || 'pending'; hit = true; } });
      if (hit) copiesSave(list);
      if (m.copyId === this.activeCopy) {
        this.store.toast(m.status === 'applied' ? 'Ваш merge-запрос принят' : 'Ваш merge-запрос отклонён', m.status === 'applied' ? 'ok' : 'warn');
      }
    });
    sock.on('vetvi:error', (m: { message?: string }) => {
      if (m && m.message) this.store.toast(m.message, 'err');
    });
  }

  askRoomPassword(roomId: string, pid: string | null, opts: JoinOpts): void {
    this.setStatus('err');
    this.pwPending = { roomId, pid, opts, wrong: !!opts._pwWrong };
    this.store.openModal('roomPass');
  }

  /** Ввод пароля комнаты (окно roomPass → кнопка «Войти»). */
  submitRoomPassword(v: string): boolean {
    const p = this.pwPending;
    if (!p) return true;
    if (!v) {
      this.store.toast('Введите пароль комнаты', 'warn');
      return false;
    }
    this.joinPass = v;
    const opts = { ...p.opts, _pwWrong: false };
    const roomId = p.roomId;
    const pid = p.pid;
    this.pwPending = null;
    this.store.closeModal();
    this.connect(roomId, pid, opts);
    return true;
  }

  cancelRoomPassword(): void {
    this.pwPending = null;
    this.disconnect(true);
    this.store.toast('Вход в комнату отменён', 'warn');
  }

  /** Ручное переподключение (клик по чипу со статусом разрыва). */
  reconnect(): void {
    if (!this.enabled || !this.room) return;
    if (this.status === 'on') { this.store.toast('Соединение уже активно'); return; }
    this.store.toast('Переподключение…');
    const room = this.room;
    const pid = this.projectId;
    const own = this.mode !== 'copy';
    this.lastSent = '';
    this.connect(room, pid, { silent: true, own });
  }

  disconnect(silent = false): void {
    this.lockGiveAll();
    if (this.lockHB) { clearInterval(this.lockHB); this.lockHB = null; }
    if (this.sock) {
      try { this.sock.disconnect(); } catch { /* уже отвалился */ }
    }
    this.sock = null;
    this.enabled = false;
    this.room = null;
    this.store.syncUsers = [];
    this.mergeCount = 0;
    this.pendingRemote = null;
    this.pendingRemoteAt = 0;
    this.allowForeignOnce = false;
    this.rlocks = null;
    this.store.syncLocks = {};
    this.joinPass = null;
    this.store.syncFocus = {};
    this.myFocus = null;
    this.focusSent = null;
    if (this.mode !== 'copy') this.mode = 'local';
    this.setHash(null);
    this.renderUI();
    if (!silent) this.store.toast('Вы вышли из совместной комнаты', 'warn');
  }

  leaveIfRoom(): void {
    if (this.enabled) this.disconnect(true);
    else if (this.mode !== 'copy') {
      this.mode = 'local';
      this.activeCopy = null;
      this.renderUI();
    }
  }

  /* ═══ применение удалённого состояния ═══ */

  applyRemote(doc: SyncDoc | null, fit: boolean, keepPid = false, preserveTouchedAfter = 0): void {
    if (!doc || !Array.isArray(doc.nodes)) return;
    this.applyingRemote = true;
    try {
      /* снимок комнаты — авторитетный (last-write-wins): клиент ПЕРЕНИМАЕТ projectId
         комнаты. Без этого защита flushState «публикуется только свой проект» после
         чужого снимка навсегда блокировала публикацию (projectId расходился с doc.meta
         навсегда) — синхронизация умирала целиком, жили только live-события перетаскиваний. */
      if (this.mode !== 'copy') {
        const rp = (doc.meta as { projectId?: unknown } | undefined)?.projectId;
        if (typeof rp === 'string' && rp && rp !== this.projectId) {
          this.projectId = rp;
          if (this.room) this.setHash(this.room, rp); /* хеш отражает реальный проект комнаты */
        }
      }
      this.store.applyRemoteDoc(doc as Record<string, unknown>, keepPid, preserveTouchedAfter);
      if (fit) {
        const api = canvasApi.current;
        const r = api ? api.getRect() : null;
        if (r && api) this.store.fitView(r.width, r.height, api.sizes);
      }
      /* применён свежий снимок — старый отложенный уже не актуален, а эхо-публикация
         того же содержимого не нужна (lastSent = применённый документ) */
      this.pendingRemote = null;
      try { this.lastSent = JSON.stringify(this.store.syncDocObj()); } catch { /* нет сериализации */ }
    } finally {
      this.applyingRemote = false;
    }
  }

  handleRemoteDoc(doc: SyncDoc | null | undefined): void {
    if (!doc || !Array.isArray(doc.nodes)) return;
    /* снимок, пришедший во время применения другого, не выбрасываем — откладываем:
     * выброс терял правки соавтора безвозвратно (следующий паблиш перезаписывал их) */
    if (this.applyingRemote) { this.pendingRemote = doc; this.pendingRemoteAt = Date.now(); return; }
    if (this.store.busyNow()) { this.pendingRemote = doc; this.pendingRemoteAt = Date.now(); return; }
    this.applyRemote(doc, false);
  }

  /* ═══ публикация состояния ═══ */

  queueState(): void {
    if (!this.enabled || this.applyingRemote) return;
    if (this.stateT) clearTimeout(this.stateT);
    this.stateT = setTimeout(() => this.flushState(false), 160);
  }

  flushState(force = false): void {
    if (!this.enabled || !this.sock || !this.sock.connected) return;
    if (this.applyingRemote && !force) return;
    const doc = this.store.syncDocObj();
    /* flushSave больше не публикует, поэтому сюда попадают ТОЛЬКО реальные правки
       открытого документа (scheduleSave мутаций и явные публикации). Если открытый
       документ — другой проект, комната переходит на него (last-write-wins): клиент
       перенимает его projectId и публикует. Прежнее поведение (тихий return) убивало
       синхронизацию навсегда: projectId расходился с документом после чужого снимка
       или «Опубликовать мою», оба участника переставали публиковать состояние —
       в комнате работали только live-перетаскивания, ничего не сохранялось.
       Принятие projectId безусловно — и для force-публикации («Опубликовать мою»):
       комната переходит на опубликованный проект немедленно, а не после следующей правки. */
    {
      const roomPid = this.projectId;
      const docPid = (doc.meta && typeof (doc.meta as { projectId?: unknown }).projectId === 'string')
        ? String((doc.meta as { projectId?: string }).projectId) : '';
      if (roomPid && docPid && roomPid !== docPid) {
        this.projectId = docPid;
        if (this.room) this.setHash(this.room, docPid); /* хеш отражает реальный проект комнаты */
      }
    }
    let json = '';
    try { json = JSON.stringify(doc); } catch { return; }
    if (json === this.lastSent && !force) return;
    this.lastSent = json;
    try { this.sock.emit('vetvi:state', { roomId: this.room, doc }); } catch { /* соединение умерло */ }
  }

  /* ═══ живые перетаскивания (троттлинг как в оригинале) ═══ */

  liveDrag(src: { ids?: Set<string>; cards?: Set<string> }): void {
    if (!this.enabled || !this.sock || !this.sock.connected || this.applyingRemote) return;
    const now = Date.now();
    if (now - this.liveT < 55) return;
    this.liveT = now;
    const nodes: { id: string; x: number; y: number }[] = [];
    const groups: { id: string; x: number; y: number }[] = [];
    if (src && src.ids) {
      src.ids.forEach((id) => {
        const n = this.store.nodeById(id);
        if (n) nodes.push({ id, x: n.x, y: n.y });
      });
    }
    if (src && src.cards) {
      src.cards.forEach((gid) => {
        const g = this.store.groupById(gid);
        if (g && (g.fold === undefined ? 2 : g.fold) < 2) groups.push({ id: gid, x: g.x, y: g.y });
      });
    }
    if (!nodes.length && !groups.length) return;
    try { this.sock.emit('vetvi:live', { roomId: this.room, nodes, groups }); } catch { /* соединение умерло */ }
  }

  liveDlg(n: VetviNode): void {
    if (!this.enabled || !this.sock || !this.sock.connected || this.applyingRemote) return;
    const now = Date.now();
    if (now - this.liveDlgT < 70) return;
    this.liveDlgT = now;
    try { this.sock.emit('vetvi:live', { roomId: this.room, dlgW: [{ id: n.id, w: n.dlgWidth || 216 }] }); } catch { /* соединение умерло */ }
  }

  livePts(ed: VetviEdge): void {
    if (!this.enabled || !this.sock || !this.sock.connected || this.applyingRemote) return;
    const now = Date.now();
    if (now - this.livePtsT < 70) return;
    this.livePtsT = now;
    try {
      this.sock.emit('vetvi:live', {
        roomId: this.room,
        pts: [{ eid: ed.id, pts: (ed.pts || []).map((p) => ({ x: p.x, y: p.y })) }],
      });
    } catch { /* соединение умерло */ }
  }

  applyLive(m: { nodes?: { id: string; x: number; y: number }[]; groups?: { id: string; x: number; y: number }[]; pts?: { eid: string; pts: { x: number; y: number }[] }[]; dlgW?: { id: string; w: number }[] }): void {
    if (!m || this.applyingRemote) return;
    let changed = false;
    if (m.nodes) {
      m.nodes.forEach((u) => {
        const n = this.store.nodeById(u.id);
        if (!n) return;
        n.x = u.x;
        n.y = u.y;
        /* живой сдвиг соавтора — тоже «свежая» позиция: отложенный снимок,
           пришедший раньше этих событий, не должен её затереть */
        this.store.touchPos('n:' + u.id);
        changed = true;
      });
    }
    if (m.groups) {
      m.groups.forEach((u) => {
        const g = this.store.groupById(u.id);
        if (!g) return;
        g.x = u.x;
        g.y = u.y;
        this.store.touchPos('g:' + u.id);
        changed = true;
      });
    }
    if (m.pts) {
      m.pts.forEach((u) => {
        const ed = this.store.edgeById(u.eid);
        if (ed && Array.isArray(u.pts)) { ed.pts = u.pts; this.store.touchPos('e:' + u.eid); changed = true; }
      });
    }
    if (m.dlgW) {
      m.dlgW.forEach((u) => {
        const n = this.store.nodeById(u.id);
        if (n) { n.dlgWidth = u.w; this.store.touchPos('n:' + u.id); changed = true; }
      });
    }
    if (changed) this.store.emit();
  }

  /* ═══ блокировки объектов (soft-lock) ═══ */

  lockApplyServerList(list: LockInfo[] | undefined): void {
    /* сервер присылает [{id: objectId, userId, name, color}] — карта по id объекта,
       в значении сохраняем id пользователя (для отличения своих локов от чужих) */
    const map: Record<string, LockInfo> = {};
    (list || []).forEach((l) => {
      if (l && l.id) map[l.id] = { id: (l as LockInfo & { userId?: string }).userId || l.id, name: l.name || '', color: l.color || '#8b929c' };
    });
    this.rlocks = map;
    this.store.syncLocks = map;
    this.store.emit();
  }

  /** Лок, мешающий правке (не мой) — для инспектора и жестов. */
  blockedBy(ids: string[] | Set<string> | null | undefined): LockInfo | null {
    if (!this.enabled || !this.rlocks) return null;
    const me = getMe();
    for (const id of (Array.isArray(ids) ? ids : ids ? [...ids] : [])) {
      const l = this.rlocks[id];
      if (l && l.id !== me.id) return { id: l.id, name: l.name, color: l.color };
    }
    return null;
  }

  lockTake(ids: string[] | Set<string>): void {
    if (!this.enabled || !this.sock || !this.sock.connected) return;
    const arr = Array.isArray(ids) ? ids : [...ids];
    const clean: string[] = [];
    for (const id of arr) {
      if (id && !this.myLocks[id]) { this.myLocks[id] = 1; clean.push(id); }
    }
    if (!clean.length) return;
    try {
      this.sock.emit('vetvi:lock', { roomId: this.room, ids: clean }, (res: { ok?: boolean; denied?: { id: string; by: LockInfo }[] }) => {
        if (res && res.ok && Array.isArray(res.denied) && res.denied.length) this.lockHandleDenied(res.denied);
      });
    } catch { /* соединение умерло */ }
  }

  lockGive(ids: string[] | Set<string>): void {
    if (!this.sock || !this.sock.connected) return;
    const arr = Array.isArray(ids) ? ids : [...ids];
    const out: string[] = [];
    for (const id of arr) {
      if (id && this.myLocks[id]) { delete this.myLocks[id]; out.push(id); }
    }
    if (!out.length) return;
    try { this.sock.emit('vetvi:unlock', { roomId: this.room, ids: out }); } catch { /* соединение умерло */ }
  }

  lockGiveAll(except?: string[] | Set<string>): void {
    const skip = except ? new Set(Array.isArray(except) ? except : [...except]) : null;
    /* edit-локи (набор текста) переживают конец жеста — их отдаёт editSoftUnlock (11940 оригинала) */
    const ids = Object.keys(this.myLocks || {}).filter((id) => !skip || !skip.has(id));
    for (const id of ids) delete this.myLocks[id];
    if (!ids.length || !this.sock || !this.sock.connected) return;
    try { this.sock.emit('vetvi:unlock', { roomId: this.room, ids }); } catch { /* соединение умерло */ }
  }

  lockHeartbeat(): void {
    const ids = Object.keys(this.myLocks || {});
    if (!ids.length || !this.enabled || !this.sock || !this.sock.connected) return;
    try { this.sock.emit('vetvi:lock', { roomId: this.room, ids }, () => { /* ack */ }); } catch { /* соединение умерло */ }
  }

  /** Проигранная гонка: сервер отказал в локе — откатываем активный жест. */
  lockHandleDenied(denied: { id: string; by: LockInfo }[]): void {
    const ids: Record<string, LockInfo> = {};
    denied.forEach((d) => { if (d && d.id) ids[d.id] = d.by || { id: '', name: '', color: '' }; });
    const firstBy = denied[0] && denied[0].by ? denied[0].by : null;
    const has = (list: string[] | Set<string>) => [...list].some((id) => ids[id]);
    for (const id of Object.keys(ids)) delete this.myLocks[id];
    let hit = false;
    /* проигранная гонка набора текста: снимаем фокус с поля (11974–11986 оригинала) */
    if (this.store.editLockDenied(new Set(Object.keys(ids)))) hit = true;
    /* откат активного жеста: ТОЛЬКО объекты жеста возвращаются к снимку начала
       (applySnap оригинала) — чужие параллельные правки не затираются целиком.
       Список объектов читаем ДО очистки жеста (ack может прийти после pointerup). */
    const snap = this.store.dragStartSnapshot;
    const gids = new Set(this.store.gestureIds);
    if (snap && (this.store.dragMoved || this.store.syncBusyFlag)) {
      try {
        if (this.store.restoreGesturePositions(snap, gids)) hit = true;
      } catch { /* нет снимка */ }
    }
    this.store.dragStartSnapshot = null;
    this.store.dragMoved = false;
    this.store.finishGestureDrag();
    if (this.store.gestureRollback) {
      const rb = this.store.gestureRollback;
      this.store.gestureRollback = null;
      try { rb(); hit = true; } catch { /* жест уже завершён */ }
    }
    if (!hit) return;
    this.store.showLockTip(
      lastPtr.x,
      lastPtr.y,
      firstBy ? { id: firstBy.id || '', name: firstBy.name || '', color: firstBy.color || '#8b929c' } : null,
    );
  }

  /* ═══ фокус участников ═══ */

  focusTrack(id: string): void {
    if (!id) return;
    this.myFocus = id;
    this.focusEmit();
  }

  focusEmit(): void {
    const id = this.myFocus;
    if (!this.enabled || !this.sock || !this.sock.connected || !id) return;
    if (this.focusSent === id) return;
    this.focusSent = id;
    try { this.sock.emit('vetvi:focus', { roomId: this.room, nodeId: id }); } catch { /* соединение умерло */ }
  }

  focusApply(list: { userId: string; nodeId: string }[] | undefined): void {
    const map: Record<string, string> = {};
    (list || []).forEach((f) => { if (f && f.userId && f.nodeId) map[f.userId] = f.nodeId; });
    this.store.syncFocus = map;
    this.store.emit();
  }

  focusGo(userId: string): void {
    const nid = this.store.syncFocus ? this.store.syncFocus[userId] : null;
    const n = nid ? this.store.nodeById(nid) : null;
    if (!n) { this.store.toast('Нода участника недоступна — возможно, она удалена', 'warn'); return; }
    let uname = '';
    (this.store.syncUsers || []).forEach((u) => { if (u.id === userId) uname = u.name; });
    this.store.selectOnly(n.id);
    this.store.requestCenter(n.id);
    this.store.toast('Переход к ноде «' + (n.title || '…') + '»' + (uname ? ' — ' + uname : ''));
  }

  /* ═══ «Поделиться» ═══ */

  shareProject(): void {
    if (this.mode === 'copy') {
      this.store.toast('Это копия — поделиться можно только оригиналом проекта', 'warn');
      return;
    }
    const p = this.hashParams();
    if (this.enabled && p.room && this.room === p.room) {
      this.store.openModal('share');
      return;
    }
    const roomId = (uid() + uid() + uid()).slice(0, 24);
    if (!this.store.doc.meta.projectId) this.store.doc.meta.projectId = uid() + uid();
    this.store.scheduleSave();
    this.setHash(roomId, String(this.store.doc.meta.projectId));
    this.connect(roomId, String(this.store.doc.meta.projectId), { pushLocal: true });
    this.store.openModal('share');
  }

  copyShareLink(): void {
    const u = this.shareUrl();
    if (!u) { this.store.toast('Комната ещё не открыта', 'warn'); return; }
    const done = () => this.store.toast('Ссылка скопирована');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(u).then(done).catch(() => this.fallbackCopy(u, done));
    } else this.fallbackCopy(u, done);
  }

  fallbackCopy(t: string, done?: () => void): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      if (done) done();
    } catch {
      this.store.toast('Не удалось скопировать — выделите ссылку вручную', 'err');
    }
  }

  renameMe(name: string): void {
    const v = (name || '').trim();
    if (!v) return;
    const m = setMeName(v);
    if (this.sock && this.sock.connected) {
      try { this.sock.emit('vetvi:join', { roomId: this.room, user: { id: m.id, name: m.name, color: m.color } }, () => { /* ack */ }); } catch { /* соединение умерло */ }
    }
    this.store.toast('Имя обновлено: ' + v);
    this.store.emit();
  }

  /* ═══ пароль проекта: синхронизация в комнату ═══ */

  pushPass(mode: 'set' | 'clear', salt: string | null, hash: string | null, curPw: string): void {
    if (!this.enabled || !this.sock || !this.sock.connected) return;
    try {
      this.sock.emit('vetvi:pass', {
        roomId: this.room,
        mode,
        salt: salt || undefined,
        hash: hash || undefined,
        password: curPw || this.store.syncProjPass || this.joinPass || '',
      }, (res: { ok?: boolean; error?: string }) => {
        if (res && res.ok) this.store.toast(mode === 'set' ? 'Пароль комнаты обновлён' : 'Пароль комнаты снят');
        else if (res && res.error === 'password') this.store.toast('Не удалось обновить пароль комнаты — нужен прежний пароль', 'warn');
      });
    } catch { /* соединение умерло */ }
  }

  passSetModal(change: boolean): void {
    this.store.openModal('passSet', change ? 'change' : 'set');
  }

  /** Применение введённых в окне паролей (passSetModal → «Установить/Сменить»). */
  passSetApply(cur: string, a: string, b: string, change: boolean): boolean {
    const meta = this.store.doc.meta as unknown as { passHash?: string; passSalt?: string };
    const needCur = change && meta && meta.passHash;
    if (needCur && !this.store.passOk(cur)) {
      this.store.toast('Текущий пароль неверен', 'err');
      return false;
    }
    if (!a) { this.store.toast('Введите новый пароль', 'warn'); return false; }
    if (a !== b) { this.store.toast('Пароли не совпадают', 'warn'); return false; }
    const salt = passRandomSalt();
    meta.passSalt = salt;
    meta.passHash = sha256hex(salt + ':' + a);
    this.store.syncProjPass = a;
    this.store.lockUnlocked = true;
    this.store.passRememberSession();
    this.store.scheduleSave();
    this.store.emit();
    this.store.toast('Пароль проекта установлен');
    this.pushPass('set', salt, meta.passHash, a);
    return true;
  }

  /** Окно «Убрать пароль» → подтверждение с текущим паролем. */
  passRemoveApply(cur: string): boolean {
    if (!this.store.passOk(cur)) {
      this.store.toast('Пароль неверен', 'err');
      return false;
    }
    const meta = this.store.doc.meta as unknown as { passSalt?: string; passHash?: string };
    delete meta.passSalt;
    delete meta.passHash;
    this.store.syncProjPass = null;
    this.store.lockUnlocked = true;
    this.store.scheduleSave();
    this.store.emit();
    this.store.toast('Пароль снят');
    this.pushPass('clear', null, null, cur);
    return true;
  }

  /* ═══ копии ═══ */

  activeCopyObj(): SyncCopy | null {
    if (!this.activeCopy) return null;
    const list = copiesAll();
    for (const c of list) if (c.copyId === this.activeCopy) return c;
    return null;
  }

  /** Сохранение текущего состояния в открытую копию (вызывается из persist()). */
  persistCopyTick(): void {
    if (!this.activeCopy) return;
    const list = copiesAll();
    for (const c of list) {
      if (c.copyId === this.activeCopy) {
        c.state = JSON.parse(JSON.stringify(this.store.syncDocObj())) as Record<string, unknown>;
        c.editedAt = new Date().toISOString();
        break;
      }
    }
    copiesSave(list);
  }

  makeCopy(): SyncCopy {
    const now = new Date().toISOString();
    const cp: SyncCopy = {
      copyId: uid() + uid(),
      name: (this.store.doc.meta.name || 'Без названия') + ' — копия',
      createdAt: now,
      editedAt: now,
      sourceRoomId: this.enabled ? this.room : null,
      sourceProjectId: (this.store.doc.meta.projectId as string) || null,
      state: JSON.parse(JSON.stringify(this.store.syncDocObj())) as Record<string, unknown>,
      base: JSON.parse(JSON.stringify(this.store.syncDocObj())) as Record<string, unknown>,
      lastMergeId: null,
      lastMergeStatus: null,
    };
    const list = copiesAll();
    list.unshift(cp);
    copiesSave(list);
    this.store.toast('Локальная копия создана');
    return cp;
  }

  openCopyById(copyId: string): void {
    let cp: SyncCopy | null = null;
    for (const c of copiesAll()) if (c.copyId === copyId) cp = c;
    if (!cp) { this.store.toast('Копия не найдена', 'err'); return; }
    if (this.enabled) this.disconnect(true);
    this.mode = 'copy';
    this.activeCopy = copyId;
    const p = (cp.state || {}) as SyncDoc;
    this.store.applyRemoteDoc({
      meta: p.meta || { name: cp.name, created: cp.createdAt, modified: cp.editedAt },
      nodes: p.nodes || [],
      edges: p.edges || [],
      groups: p.groups || [],
    } as unknown as Record<string, unknown>, true);
    this.renderUI();
    this.store.toast('Открыта копия: ' + cp.name, 'warn');
  }

  deleteCopyById(copyId: string): void {
    let list = copiesAll();
    list = list.filter((c) => c.copyId !== copyId);
    copiesSave(list);
    if (this.activeCopy === copyId) this.exitCopyMode(false);
    this.store.toast('Копия удалена');
    this.store.openModal('copies');
  }

  exitCopyMode(reconnect: boolean): void {
    const cp = this.activeCopyObj();
    this.activeCopy = null;
    if (reconnect && cp && cp.sourceRoomId) {
      /* вернуться к основному проекту (зеркало LS_KEY) и снова войти в комнату */
      const raw = stItem('vetvi-autosave-v17');
      if (raw) {
        try {
          const d = JSON.parse(raw) as { project?: Record<string, unknown> };
          if (d && d.project) this.store.applyRemoteDoc(d.project, true);
        } catch { /* нет зеркала */ }
      }
      this.mode = 'room';
      this.connect(cp.sourceRoomId, cp.sourceProjectId, {});
    } else {
      const raw2 = stItem('vetvi-autosave-v17');
      if (raw2) {
        try {
          const d2 = JSON.parse(raw2) as { project?: Record<string, unknown> };
          if (d2 && d2.project) this.store.applyRemoteDoc(d2.project, true);
          this.store.toast('Вернулись к основному проекту');
        } catch { /* нет зеркала */ }
      }
      this.mode = 'local';
      this.renderUI();
    }
  }

  /** Закрыть панель копии (режим копии → локальный). */
  exitCopyPanel(): void {
    this.mode = 'local';
    this.activeCopy = null;
    this.renderUI();
    this.store.toast('Панель копии закрыта');
  }

  /* ═══ merge-запросы ═══ */

  /** Служебный сокет для merge-операций (вне комнат). */
  opCall(ev: string, payload: Record<string, unknown>, cb?: (res: { ok?: boolean; [k: string]: unknown }) => void): void {
    if (!this.opSock) {
      this.opSock = io(SYNC_URL, {
        path: '/',
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 800,
        reconnectionDelayMax: 4000,
      });
    }
    const sock = this.opSock;
    const send = () => {
      try { sock.emit(ev, payload, (res: { ok?: boolean }) => { if (cb) cb(res); }); } catch { if (cb) cb({ ok: false, error: 'emit failed' }); }
    };
    if (sock.connected) send();
    else sock.once('connect', send);
  }

  sendMerge(): void {
    const cp = this.activeCopyObj();
    if (!cp) { this.store.toast('Откройте копию, чтобы отправить merge', 'warn'); return; }
    if (!cp.sourceRoomId) { this.store.toast('Копия не привязана к комнате — отправлять некуда', 'err'); return; }
    let cur: Record<string, unknown>;
    try { cur = JSON.parse(JSON.stringify(this.store.syncDocObj())) as Record<string, unknown>; } catch { return; }
    const stats = mergeStats(cp.base, cur);
    const total = stats.addedNodes + stats.changedNodes + stats.removedNodes + stats.addedEdges + stats.changedEdges + stats.removedEdges;
    if (!total) { this.store.toast('В копии нет изменений относительно базы — отправлять нечего', 'warn'); return; }
    const me = getMe();
    this.opCall('vetvi:merge-send', {
      roomId: cp.sourceRoomId,
      copyId: cp.copyId,
      sender: { name: me.name, color: me.color },
      stats,
      doc: { current: cur, base: cp.base },
    }, (res) => {
      if (res && res.ok) {
        const list = copiesAll();
        list.forEach((c) => {
          if (c.copyId === cp.copyId) { c.lastMergeId = (res.id as string) || null; c.lastMergeStatus = 'pending'; }
        });
        copiesSave(list);
        this.store.toast('Merge-запрос отправлен владельцу оригинала');
      } else {
        this.store.toast('Не удалось отправить merge: ' + ((res && res.error) || 'ошибка'), 'err');
      }
    });
  }

  refreshMergeStatuses(cb?: () => void): void {
    const list = copiesAll();
    const ids: string[] = [];
    list.forEach((c) => { if (c.lastMergeId) ids.push(c.lastMergeId); });
    if (!ids.length) { if (cb) cb(); return; }
    this.opCall('vetvi:merge-status', { ids }, (res) => {
      if (res && res.ok) {
        const st = (res.statuses || {}) as Record<string, string>;
        const list2 = copiesAll();
        let changed = false;
        list2.forEach((c) => {
          if (c.lastMergeId && st[c.lastMergeId] && st[c.lastMergeId] !== c.lastMergeStatus) {
            c.lastMergeStatus = st[c.lastMergeId];
            changed = true;
          }
        });
        if (changed) copiesSave(list2);
      }
      if (cb) cb();
    });
  }

  mergeRequests(cb: (res: { ok?: boolean; requests?: MergeRequest[]; pending?: number }) => void): void {
    if (!this.room) {
      this.store.toast('Merge-запросы доступны внутри комнаты проекта', 'warn');
      return;
    }
    this.opCall('vetvi:merge-list', { roomId: this.room }, (res) => {
      if (res && res.ok) {
        const reqs = (res.requests || []) as MergeRequest[];
        void reqs;
        this.mergeCount = ((res.pending as number | undefined) || 0);
        this.renderUI();
      }
      cb(res as { ok?: boolean; requests?: MergeRequest[]; pending?: number });
    });
  }

  decideMerge(rid: string, act: 'apply' | 'reject'): void {
    const roomId = this.room;
    if (!roomId) return;
    this.opCall('vetvi:merge-list', { roomId }, (res) => {
      let req: MergeRequest | null = null;
      (((res && res.requests) || []) as MergeRequest[]).forEach((x) => { if (x.id === rid) req = x; });
      if (!req) { this.store.toast('Merge-запрос не найден', 'err'); return; }
      if (act === 'apply') {
        this.applyMergeRequest(req as MergeRequest);
        this.opCall('vetvi:merge-decide', { roomId, requestId: rid, decision: 'applied' }, () => { /* ack */ });
      } else {
        this.opCall('vetvi:merge-decide', { roomId, requestId: rid, decision: 'rejected' }, () => { /* ack */ });
        this.store.toast('Merge-запрос отклонён', 'warn');
      }
    });
  }

  /** Применение merge: бэкап локально + снимок в историю + трёхстороннее слияние. */
  applyMergeRequest(req: MergeRequest): void {
    const base = req.doc && req.doc.base;
    const cur = req.doc && req.doc.current;
    if (!cur || !Array.isArray(cur.nodes)) { this.store.toast('Повреждённый merge-запрос', 'err'); return; }
    const backups = backupsRead();
    backups.unshift({
      id: uid(),
      at: new Date().toISOString(),
      label: 'Перед merge от ' + ((req.sender && req.sender.name) || 'гостя'),
      doc: JSON.parse(JSON.stringify(this.store.syncDocObj())) as Record<string, unknown>,
    });
    if (backups.length > 10) backups.length = 10;
    try { stSetItem(LS_BACKUPS, JSON.stringify(backups)); } catch { /* хранилище переполнено */ }
    this.store.pushHistory('Слияние копий');
    const result = mergeDocs(base, cur, {
      nodes: this.store.doc.nodes,
      edges: this.store.doc.edges,
      groups: this.store.doc.groups,
      customTypes: (Array.isArray(this.store.doc.customTypes) ? this.store.doc.customTypes : []) as IdObjList,
    });
    this.store.doc.nodes = result.nodes as unknown as VetviNode[];
    this.store.doc.edges = result.edges as unknown as VetviEdge[];
    this.store.doc.groups = result.groups as unknown as VetviGroup[];
    this.store.doc.customTypes = result.customTypes;
    if (result.listHidden) this.store.doc.listHidden = result.listHidden;
    if (result.name) this.store.doc.meta.name = result.name;
    this.store.scheduleSave();
    this.store.emit();
    this.store.toast('Merge применён · бэкап сохранён локально');
  }

  /* ═══ старт: хэш, переподключение, очередь удалённых снимков ═══ */

  init(): void {
    const p = this.hashParams();
    /* чужая комната из хэша (ссылка соавтора) — вход после разблокировки проекта */
    if (p.room && !this.enabled) {
      this.mode = 'room';
      this.store.lockAfterUnlock(() => {
        this.connect(p.room, p.project || null, { viaLink: true });
      });
    }
    window.addEventListener('hashchange', () => {
      const np = this.hashParams();
      if (np.room && np.room !== this.room) {
        this.mode = 'room';
        this.store.lockAfterUnlock(() => {
          this.connect(np.room, np.project || null, { viaLink: true });
        });
      }
    });
    if (!this.pollT) {
      this.pollT = setInterval(() => {
        if (this.pendingRemote && !this.store.busyNow() && !this.applyingRemote) {
          const d = this.pendingRemote;
          const at = this.pendingRemoteAt;
          this.pendingRemote = null;
          this.pendingRemoteAt = 0;
          this.applyRemote(d, false, false, at);
        }
      }, 600);
    }
  }
}

/* ═══ вспомогательные ═══ */

function copiesSave(list: SyncCopy[]): void {
  try {
    stSetItem(LS_COPIES, JSON.stringify(list));
  } catch {
    /* хранилище переполнено — обрабатывается в UI makeCopy */
  }
}

export interface MergeRequest {
  id: string;
  sender?: { name?: string; color?: string };
  createdAt?: string;
  status?: string;
  stats?: MergeStats;
  doc?: { current?: Record<string, unknown>; base?: Record<string, unknown> };
  [k: string]: unknown;
}

/* последняя позиция курсора — для подсказки о чужой блокировке */
const lastPtr = { x: 0, y: 0 };
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => { lastPtr.x = e.clientX; lastPtr.y = e.clientY; }, { passive: true });
  lastPtr.x = window.innerWidth / 2;
  lastPtr.y = window.innerHeight / 2;
}
