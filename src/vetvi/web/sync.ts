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

import { docFromParsed } from '@/vetvi/core/doc';
import { uid } from '@/vetvi/core/factory';
import { getMe } from '@/vetvi/core/identity';
import { mergeDocs, mergeStats, type MergeStats } from '@/vetvi/core/merge';
import { passRandomSalt, sha256hex } from '@/vetvi/core/passlock';
import { projList, projReadSlot } from '@/vetvi/core/projects';
import { stItem, stSetItem } from '@/vetvi/core/storage';
import type { VetviChar, VetviCharGroup, VetviEdge, VetviGroup, VetviNode } from '@/vetvi/core/types';
import { accessInit, getAccountToken } from './auth';
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

/* ═══════════ сравнение версий документа (новая система комнат) ═══════════

   Вход в комнату всегда грузит серверное состояние, а локальная копия не
   заменяется сразу: если версии различаются — в углу холста появляется блок
   со сравнением и выбором «опубликовать локальную / перезаписать локальные
   данные / смерджить». Сравнение — канонический JSON: порядок ключей внутри
   объектов не важен, «летучие» поля meta (modified/actionLog/editLog) не
   учитываются. Обе версии прогоняются через docFromParsed — одинаковые
   нормализация и дефолты. */

function canonVal(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonVal);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    Object.keys(o).sort().forEach((k) => { out[k] = canonVal(o[k]); });
    return out;
  }
  return v;
}

function canonDocJson(d: unknown): string {
  const doc = docFromParsed(d);
  const meta = (doc.meta && typeof doc.meta === 'object' ? doc.meta : {}) as Record<string, unknown>;
  const metaPick: Record<string, unknown> = {};
  /* содержательные поля meta; modified/actionLog/editLog — летучие, не сравниваются */
  ['name', 'projectId', 'created', 'passSalt', 'passHash'].forEach((k) => {
    if (meta[k] !== undefined) metaPick[k] = meta[k];
  });
  return JSON.stringify({
    meta: canonVal(metaPick),
    nodes: canonVal(doc.nodes),
    edges: canonVal(doc.edges),
    groups: canonVal(doc.groups),
    customTypes: canonVal(doc.customTypes || []),
    listHidden: canonVal(doc.listHidden || {}),
    vars: canonVal(doc.vars || []),
    varGroups: canonVal((doc as { varGroups?: unknown[] }).varGroups || []),
    chars: canonVal(doc.chars || []),
    charGroups: canonVal((doc as { charGroups?: unknown[] }).charGroups || []),
    palette: canonVal(doc.palette || []),
  });
}

function docsDiffer(a: unknown, b: unknown): boolean {
  return canonDocJson(a) !== canonDocJson(b);
}

function clonePlain(v: unknown): Record<string, unknown> {
  try { return JSON.parse(JSON.stringify(v)) as Record<string, unknown>; } catch { return { nodes: [], edges: [], groups: [] }; }
}

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
  /* роль в комнате из ack входа (owner/editor/reader/guest) — читает ShareModal */
  role: string | null = null;
  /* режим доступа по ссылке (off/members/open) — отдаёт сервер в ack join
     и в vetvi:room-settings; показывает окно «Поделиться» */
  linkMode: 'off' | 'members' | 'open' = 'open';
  rlocks: Record<string, LockInfo> | null = null;
  myLocks: Record<string, number> = {};
  lockHB: ReturnType<typeof setInterval> | null = null;
  myFocus: string | null = null;
  focusSent: string | null = null;
  opSock: Socket | null = null;
  /* ожидание пароля комнаты (окно roomPass) */
  pwPending: { roomId: string; pid: string | null; opts: JoinOpts; wrong: boolean } | null = null;
  /* идёт тихий перезаход (обновление роли) — защита от пинг-понга */
  rejoining = false;
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

  /** Роль и право на правку из ack входа: reader/guest — только чтение
   *  (сервер и сам отклоняет правки). При смене правки на лету — короткий тост. */
  private applyRole(res: { role?: string; canEdit?: boolean }, silent = false): void {
    this.role = typeof res.role === 'string' ? res.role : null;
    const canEdit = res.canEdit !== false;
    const was = this.store.viewOnly;
    this.store.viewOnly = !canEdit && this.mode === 'room';
    if (silent) return;
    if (!canEdit && !was) this.store.toast('У вас доступ только на чтение — правки недоступны', 'warn');
    else if (canEdit && was) this.store.toast('Права обновлены — редактирование разрешено', 'ok');
  }

  /** Тихий перезаход в комнату без разрыва сокета: сервер пересчитает роль
   *  (после выдачи/отзыва доступа или legacy-claim). Документ из re-ack не
   *  применяется — обновляется только роль/список участников. */
  rejoin(): void {
    const sock = this.sock;
    if (!sock || !sock.connected || !this.room || this.mode === 'copy') return;
    if (this.rejoining) return;
    this.rejoining = true;
    const me = getMe();
    const jpay: Record<string, unknown> = { roomId: this.room, user: { id: me.id, name: me.name, color: me.color }, quiet: true };
    const tok = getAccountToken();
    if (tok) { jpay.token = tok; jpay.userId = me.id; }
    const jpw = this.store.syncProjPass || this.joinPass || null;
    if (jpw) jpay.password = jpw;
    const meta = this.store.doc.meta as unknown as { passHash?: string; passSalt?: string };
    if (meta && meta.passHash) jpay.pass = { salt: String(meta.passSalt || ''), hash: String(meta.passHash) };
    sock.emit('vetvi:join', jpay, (res: { ok?: boolean; role?: string; canEdit?: boolean; users?: { id: string; name: string; color: string; canEdit?: boolean }[] } | null) => {
      this.rejoining = false;
      if (!res || !res.ok) return;
      this.applyRole(res);
      this.store.syncUsers = res.users || this.store.syncUsers;
      this.store.emit();
    });
  }

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
      /* сессия аккаунта: сервер vetvi-sync проверяет её по общей БД и берёт
         имя/цвет из записи AuthUser — имена в комнате менять нельзя */
      const tok = getAccountToken();
      if (tok) { jpay.token = tok; jpay.userId = me.id; }
      const jpw = (typeof opts.password === 'string' && opts.password) ? opts.password : (this.store.syncProjPass || this.joinPass || null);
      if (jpw) jpay.password = jpw;
      const meta = this.store.doc.meta as unknown as { passHash?: string; passSalt?: string };
      if (meta && meta.passHash) jpay.pass = { salt: String(meta.passSalt || ''), hash: String(meta.passHash) };
      sock.emit('vetvi:join', jpay, (res: { ok?: boolean; needPassword?: boolean; users?: { id: string; name: string; color: string; canEdit?: boolean }[]; locks?: LockInfo[]; focus?: { userId: string; nodeId: string }[]; pendingMerges?: number; doc?: SyncDoc; role?: string; canEdit?: boolean; legacy?: boolean; linkMode?: string; error?: string } | null) => {
        if (!res || !res.ok) {
          if (res && res.needPassword) {
            if (jpw) opts._pwWrong = true;
            this.askRoomPassword(roomId, pid, opts);
            return;
          }
          /* ссылку закрыли/ограничили: разрываем соединение с ясным сообщением */
          if (res && res.error === 'link_off') {
            this.disconnect(true);
            this.store.toast('Владелец закрыл доступ по ссылке', 'warn');
            return;
          }
          if (res && res.error === 'members_only') {
            this.disconnect(true);
            this.store.toast('По ссылке могут войти только участники, добавленные владельцем', 'warn');
            return;
          }
          this.setStatus('err');
          this.store.toast('Не удалось войти в комнату', 'err');
          return;
        }
        opts._pwWrong = false;
        this.setStatus('on');
        /* режим ссылки и роль: reader/guest — только чтение (сервер и отклоняет правки) */
        this.linkMode = res.linkMode === 'off' || res.linkMode === 'members' ? res.linkMode : 'open';
        this.applyRole(res, opts.silent);
        this.store.syncUsers = res.users || [];
        this.lockApplyServerList(res.locks);
        this.focusApply(res.focus);
        this.focusSent = null;
        this.focusEmit();
        if (!this.lockHB) this.lockHB = setInterval(() => this.lockHeartbeat(), 45000);
        this.mergeCount = this.mode === 'copy' ? 0 : (res.pendingMerges || 0);
        this.renderUI();

        const serverDoc = res.doc || null;
        if (!serverDoc) {
          this.flushState(true);
          if (!opts.silent && !opts.own) this.store.toast('Комната открыта — отправьте ссылку соавторам');
        } else {
          let localJson = '';
          try { localJson = JSON.stringify(this.store.syncDocObj()); } catch { /* нет сериализации */ }
          let serverJson = '';
          try { serverJson = JSON.stringify(serverDoc); } catch { /* нет сериализации */ }

          if (localJson === serverJson) {
            /* уже совпадаем */
          } else if (opts.pushLocal) {
            this.flushState(true);
          } else {
            /* ── новая система входа в комнату ──
               Сервер всегда авторитетен: состояние комнаты грузится в редактор,
               а локальная копия проекта НЕ заменяется сразу (skipSave). Если версии
               различаются — в углу холста появляется блок со сравнением версий и
               выбором: опубликовать локальную на сервер / перезаписать локальные
               данные серверными / смерджить. Единственное исключение — комната
               содержит СОВСЕМ другой проект при своём входе (загрязнённая комната
               или туда опубликовали чужой): тогда локальный проект не трогаем и
               блок предлагает «загрузить из комнаты» явно. Диалога «Комната уже
               содержит проект» больше нет — он вечными кругами возвращал прежний
               проект при смене проектов. */
            const roomPid = (serverDoc.meta && serverDoc.meta.projectId) ? String(serverDoc.meta.projectId) : null;
            const metaPid = typeof this.store.doc.meta.projectId === 'string' ? String(this.store.doc.meta.projectId || '') : '';
            const sameProject = !!(roomPid && metaPid && roomPid === metaPid) || (!roomPid && opts.own === true);
            const localVer = this.captureLocalVersion(roomPid);
            if (sameProject || !opts.own) {
              this.applyRemote(serverDoc, true, opts.own === true, 0, !!localVer);
              if (localVer && docsDiffer(localVer, serverDoc)) {
                this.store.setSyncDiff({ kind: 'local-server', localDoc: localVer, serverDoc: clonePlain(serverDoc), by: null, at: Date.now() });
                this.store.toast('Данные комнаты отличаются от локальной копии — см. блок в углу холста', 'warn');
              } else if (!opts.silent) {
                this.store.toast('Загружено состояние из комнаты');
              }
            } else {
              this.store.setSyncDiff({ kind: 'foreign', localDoc: clonePlain(this.store.syncDocObj()), serverDoc: clonePlain(serverDoc), by: null, at: Date.now() });
              this.store.toast('В комнате другой проект — ваши данные не заменены (см. блок в углу холста)', 'warn');
            }
          }
        }
        if (this.mergeCount > 0) this.store.toast('Merge-запросов в очереди: ' + this.mergeCount, 'warn');

        /* legacy-комната (до введения доступов): владелец заявляет владение и
           перезаходит — сервер пересчитает роль и право редактирования */
        if (res.legacy && this.mode === 'room') {
          void (async () => {
            const entry = projList().find((e) => e.roomId === roomId);
            const isOwn = opts.own === true || !!entry;
            if (!isOwn) return;
            const r = await accessInit(roomId, pid, (this.store.doc.meta.name as string) || null);
            if (!r.ok || !r.role) return;
            this.rejoin();
          })();
        }
      });
    });
    sock.on('disconnect', () => { if (this.enabled) this.setStatus('lost'); });
    sock.io.on('reconnect', () => this.setStatus('conn'));
    sock.on('connect_error', () => this.setStatus('err'));
    sock.on('vetvi:users', (m: { roomId?: string; users?: { id: string; name: string; color: string; canEdit?: boolean }[] }) => {
      if (!m || m.roomId !== this.room) return;
      this.store.syncUsers = m.users || [];
      /* самопроверка роли: владелец выдал/отозвал доступ, пока мы в комнате —
         сервер пересчитал canEdit, перезаходим без разрыва соединения */
      const meEntry = (m.users || []).find((u) => u.id === getMe().id);
      if (meEntry && this.mode === 'room' && !this.rejoining) {
        const canEdit = meEntry.canEdit !== false;
        if (canEdit === this.store.viewOnly) this.rejoin();
      }
      this.store.emit();
    });
    /* уведомление о входе участника: кто перешёл по ссылке / вошёл по доступу */
    sock.on('vetvi:notice', (m: { roomId?: string; kind?: string; user?: { id: string; name: string; color: string }; role?: string; canEdit?: boolean }) => {
      if (!m || m.roomId !== this.room || m.kind !== 'join') return;
      if (m.user && m.user.id === getMe().id) return;
      const nm = (m.user && m.user.name) || 'Кто-то';
      if (m.role === 'guest') this.store.toast(nm + ' — гость по ссылке (только чтение)', 'warn');
      else if (m.role === 'reader') this.store.toast(nm + ' — только чтение', 'warn');
      else this.store.toast(nm + ' — в комнате');
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
    sock.on('vetvi:replace', (m: { roomId?: string; doc?: SyncDoc; by?: { name?: string; color?: string } | null }) => {
      if (!m || m.roomId !== this.room) return;
      this.handleReplace(m.doc, m.by || null);
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
    /* настройки ссылки изменились владельцем (или мы — из этого окна) */
    sock.on('vetvi:room-settings', (m: { roomId?: string; linkMode?: string }) => {
      if (!m || m.roomId !== this.room) return;
      const next = m.linkMode === 'off' || m.linkMode === 'members' ? m.linkMode : 'open';
      if (next === this.linkMode) return;
      this.linkMode = next;
      this.store.emit();
    });
    /* владельца закрыл ссылку, пока мы были в комнате: гостей вежливо выгоняет */
    sock.on('vetvi:kicked', (m: { roomId?: string; reason?: string }) => {
      if (!m || m.roomId !== this.room) return;
      const why = m.reason === 'members'
        ? 'По ссылке могут войти только участники, добавленные владельцем'
        : 'Владелец закрыл доступ по ссылке';
      this.disconnect(true);
      this.store.toast(why, 'warn');
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
    this.role = null;
    this.linkMode = 'open';
    this.store.syncUsers = [];
    this.store.viewOnly = false;
    this.mergeCount = 0;
    this.pendingRemote = null;
    this.pendingRemoteAt = 0;
    this.allowForeignOnce = false;
    this.store.syncDiff = null;
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

  applyRemote(doc: SyncDoc | null, fit: boolean, keepPid = false, preserveTouchedAfter = 0, skipSave = false): void {
    if (!doc || !Array.isArray(doc.nodes)) return;
    this.applyingRemote = true;
    try {
      /* снимок комнаты — авторитетный (last-write-wins): клиент ПЕРЕНИМАЕТ projectId
         комнаты. Без этого после чужого снимка публикация навсегда блокировалась
         (projectId расходился с doc.meta) — синхронизация умирала целиком,
         жили только live-события перетаскиваний. */
      if (this.mode !== 'copy') {
        const rp = (doc.meta as { projectId?: unknown } | undefined)?.projectId;
        if (typeof rp === 'string' && rp && rp !== this.projectId) {
          this.projectId = rp;
          if (this.room) this.setHash(this.room, rp); /* хеш отражает реальный проект комнаты */
        }
      }
      this.store.applyRemoteDoc(doc as Record<string, unknown>, keepPid, preserveTouchedAfter, skipSave);
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

  /* ═══ замена данных комнаты (новая система: изменения приезжают на сравнение) ═══ */

  /** Участник заменил данные на сервере (vetvi:replace): НЕ применяем сразу —
   *  блок в углу холста показывает «пришли изменения» со сравнением версий. */
  handleReplace(doc: SyncDoc | null | undefined, by: { name?: string; color?: string } | null): void {
    if (!doc || !Array.isArray(doc.nodes)) return;
    if (this.applyingRemote) return;
    this.store.setSyncDiff({
      kind: 'incoming',
      localDoc: clonePlain(this.store.syncDocObj()),
      serverDoc: clonePlain(doc),
      by: by ? { name: by.name || '', color: by.color || '' } : null,
      at: Date.now(),
    });
    this.store.toast('Участник ' + ((by && by.name) || '') + ' заменил данные на сервере — пришли изменения (см. блок в углу холста)', 'warn');
  }

  /** Явная публикация версии в комнату как «замена данных» (кнопки блока расхождения):
   *  у соавторов изменения НЕ применяются сразу — показывается сравнение. */
  publishReplace(doc: SyncDoc): void {
    if (!this.enabled || !this.sock || !this.sock.connected) return;
    if (this.store.viewOnly) { this.store.toast('Только чтение: публикация недоступна', 'warn'); return; }
    const me = getMe();
    try { this.sock.emit('vetvi:replace', { roomId: this.room, doc, by: { name: me.name, color: me.color } }); } catch { /* соединение умерло */ }
    try { this.lastSent = JSON.stringify(doc); } catch { /* нет сериализации */ }
    /* закрепить комнату за проектом опубликованной версии в реестре */
    this.store.scheduleSave();
  }

  /** Локальная копия проекта комнаты для блока сравнения: текущий документ, если
   *  открыт именно этот проект (включая несохранённые правки), иначе слот проекта. */
  captureLocalVersion(roomPid: string | null): Record<string, unknown> | null {
    if (!roomPid) return null;
    const metaPid = typeof this.store.doc.meta.projectId === 'string' ? String(this.store.doc.meta.projectId || '') : '';
    if (metaPid && metaPid === roomPid) return clonePlain(this.store.syncDocObj());
    try {
      const slot = projReadSlot(roomPid);
      if (slot && slot.doc) return clonePlain(slot.doc);
    } catch { /* нет слота */ }
    return null;
  }

  /* ── действия блока расхождения (SyncDiffModal) ── */

  /** «Опубликовать локальную версию на сервер»: локальная версия возвращается в
   *  редактор и заменяет данные комнаты; соавторы получают её на сравнение. */
  diffPushLocal(): void {
    const d = this.store.syncDiff;
    if (!d) return;
    if (d.kind !== 'foreign') this.applyRemote(d.localDoc as SyncDoc, false);
    this.publishReplace(d.localDoc as SyncDoc);
    this.store.clearSyncDiff();
    this.store.toast('Локальная версия опубликована на сервере', 'ok');
  }

  /** «Перезаписать локальные данные серверными» / «Принять изменения» / «Загрузить
   *  из комнаты»: версия комнаты применяется к редактору и слоту. */
  diffTakeServer(): void {
    const d = this.store.syncDiff;
    if (!d) return;
    this.applyRemote(d.serverDoc as SyncDoc, true);
    this.store.clearSyncDiff();
    this.store.toast(d.kind === 'incoming' ? 'Изменения приняты' : 'Локальные данные перезаписаны данными комнаты');
  }

  /** «Смерджить»: локальные изменения поверх версии комнаты (объекты, изменённые
   *  локально, берутся из локальной версии; добавления обеих сторон остаются;
   *  удалённые локально объекты выпадают). Результат применяется и публикуется
   *  как замена данных комнаты. */
  diffMerge(): void {
    const d = this.store.syncDiff;
    if (!d) return;
    const server = d.serverDoc as SyncDoc;
    const local = d.localDoc as SyncDoc;
    const result = mergeDocs(server, local as unknown as Record<string, unknown>, {
      nodes: (server.nodes || []) as unknown as IdObjList,
      edges: (server.edges || []) as unknown as IdObjList,
      groups: (server.groups || []) as unknown as IdObjList,
      customTypes: (Array.isArray(server.customTypes) ? server.customTypes : []) as unknown as IdObjList,
    });
    const sMeta = (server.meta || {}) as Record<string, unknown>;
    const lMeta = (local.meta || {}) as Record<string, unknown>;
    const vars = byIdUnion((server.vars || []) as { id?: string }[], (local.vars || []) as { id?: string }[]);
    const varGroups = byIdUnion((server.varGroups || []) as { id?: string }[], (local.varGroups || []) as { id?: string }[]);
    const chars = byIdUnion((server.chars || []) as { id?: string }[], (local.chars || []) as { id?: string }[]);
    const charGroups = byIdUnion((server.charGroups || []) as { id?: string }[], (local.charGroups || []) as { id?: string }[]);
    const merged: SyncDoc = {
      app: 'vetvi-room',
      version: 1,
      meta: { ...sMeta, name: (lMeta.name as string) || (sMeta.name as string) || 'Без названия' },
      nodes: result.nodes as unknown as VetviNode[],
      edges: result.edges as unknown as VetviEdge[],
      groups: result.groups as unknown as VetviGroup[],
      customTypes: result.customTypes,
      listHidden: result.listHidden || {},
      vars,
      varGroups,
      chars,
      charGroups,
      palette: (Array.isArray(server.palette) ? server.palette : (Array.isArray(local.palette) ? local.palette : [])) as string[],
    };
    this.applyRemote(merged, false);
    this.publishReplace(merged);
    this.store.clearSyncDiff();
    this.store.toast('Проекты смерждены — результат опубликован на сервере', 'ok');
  }

  /** Закрыть блок расхождения без решения (×). */
  diffDismiss(): void {
    this.store.clearSyncDiff();
  }

  /* ═══ публикация состояния ═══ */

  queueState(): void {
    if (!this.enabled || this.applyingRemote) return;
    if (this.stateT) clearTimeout(this.stateT);
    this.stateT = setTimeout(() => this.flushState(false), 160);
  }

  flushState(force = false): void {
    if (!this.enabled || !this.sock || !this.sock.connected) return;
    if (this.store.viewOnly) return; // только чтение: снапшоты не публикуем (сервер и так отклонит)
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
    if (this.store.viewOnly) return;
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
        /* живой сдвиг соавтора — замена объекта ноды (сигнал memo-карточки);
           это тоже «свежая» позиция: отложенный снимок, пришедший раньше этих
           событий, не должен её затереть */
        this.store.setNodePos(u.id, u.x, u.y);
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
    if (changed) this.store.emit('geom');
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
    if (this.store.viewOnly) return; // только чтение: локи не берём
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

  /** Транслировать «работаю здесь»: id выделенной ноды или null — выделения нет
   *  (клик по пустому месту холста). null сервер воспринимает как «снять метку»:
   *  удаляет фокус участника и рассылает обновлённый список — плашка
   *  «работает здесь» на чужой стороне исчезает. */
  focusTrack(id: string | null): void {
    this.myFocus = id || null;
    this.focusEmit();
  }

  focusEmit(): void {
    if (!this.enabled || !this.sock || !this.sock.connected) return;
    const id = this.myFocus || null;
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

  /** Окно «Поделиться» — САМО ПО СЕБЕ проект не делает сетевым: публикация
   *  (подключение к серверу) включается только переключателем в окне. */
  shareProject(): void {
    if (this.mode === 'copy') {
      this.store.toast('Это копия — поделиться можно только оригиналом проекта', 'warn');
      return;
    }
    this.store.openModal('share');
  }

  /** roomId проекта: хранится в meta документа (переживает перезагрузки и
   *  публикацию), резервируется при первом открытии «Поделиться» — доступы
   *  (ProjectAccess) заводятся ДО публикации, пока проект ещё локальный. */
  shareRoomId(): string {
    const meta = this.store.doc.meta as unknown as { projectId?: string; roomId?: string };
    if (!meta.projectId) {
      meta.projectId = uid() + uid();
      this.store.scheduleSave();
    }
    if (!meta.roomId) {
      meta.roomId = (uid() + uid() + uid()).slice(0, 24);
      this.store.scheduleSave();
    }
    return String(meta.roomId);
  }

  /** Гарантировать запись владельца комнаты (идемпотентно, без входа в неё).
   *  Вызывается при открытии окна «Поделиться»: без неё владелец не может
   *  добавлять участников (API доступов требует роль owner). */
  ensureOwnerAccess(): void {
    if (this.mode === 'copy') return;
    const roomId = this.shareRoomId();
    const pid = String(this.store.doc.meta.projectId || '');
    void accessInit(roomId, pid, (this.store.doc.meta.name as string) || null).catch(() => undefined);
  }

  /** Включить сетевой режим (переключатель в окне «Поделиться»): резервируем
   *  roomId, заявляем владение, заходим в комнату и публикуем локальный проект. */
  publishProject(): void {
    if (this.mode === 'copy') {
      this.store.toast('Это копия — поделиться можно только оригиналом проекта', 'warn');
      return;
    }
    if (this.enabled && this.mode === 'room' && this.room) return; // уже опубликован
    const roomId = this.shareRoomId();
    const pid = String(this.store.doc.meta.projectId || '');
    /* владелец комнаты: запись доступа СТРОГО ДО смены хеша и входа в комнату.
       Раньше хеш менялся синхронно, а connect шёл параллельно с access/init:
       hashchange успевал войти в комнату по ссылке (join без записи доступа —
       сервер отвечал «гость» и ставил «только чтение» — потеря доступа при
       publish), а join при собственном connect приходил раньше записи в БД. */
    void (async () => {
      try {
        await accessInit(roomId, pid, (this.store.doc.meta.name as string) || null);
      } catch { /* сервер недоступен — войдём всё равно, роль придёт по legacy */ }
      /* хеш меняем только когда доступ уже записан: hashchange увидит this.room
         и не устроит повторный вход по ссылке */
      this.setHash(roomId, pid);
      this.connect(roomId, pid, { own: true, pushLocal: true });
    })();
  }

  /** Выключить сетевой режим: выходим из комнаты, ссылка перестаёт работать
   *  (hash очищается), проект остаётся локальным — доступы участников сохраняются. */
  unpublishProject(): void {
    if (this.mode === 'copy') return;
    if (!this.enabled) return;
    this.disconnect(true);
    this.store.toast('Проект снова локальный — сетевой доступ выключен', 'warn');
  }

  /** Сменить режим доступа по ссылке (off/members/open) — сервер проверяет роль
   *  владельца и раздаёт новое значение всем в комнате. */
  setRoomLinkMode(mode: 'off' | 'members' | 'open'): void {
    if (this.linkMode === mode) return;
    this.linkMode = mode;
    this.store.emit();
    if (!this.sock || !this.sock.connected || !this.room) return;
    try {
      this.sock.emit('vetvi:room-settings', { roomId: this.room, linkMode: mode }, (res: { ok?: boolean; error?: string } | null) => {
        if (res && res.ok === false) {
          this.store.toast(res.error || 'Не удалось изменить настройки ссылки', 'warn');
        }
      });
    } catch { /* соединение умерло */ }
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

  /* Смена имени удалена: имя в комнате — имя аккаунта (берётся сервером из БД). */

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
    /* персонажи и их группы: объединение по id — добавления копии и комнаты не теряются */
    const cChars = (Array.isArray(cur.chars) ? cur.chars : []) as { id?: string }[];
    this.store.doc.chars = byIdUnion(this.store.doc.chars as { id?: string }[], cChars) as unknown as VetviChar[];
    const cGroups = (Array.isArray(cur.charGroups) ? cur.charGroups : []) as { id?: string }[];
    this.store.doc.charGroups = byIdUnion(this.store.doc.charGroups as { id?: string }[], cGroups) as unknown as VetviCharGroup[];
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

/** Объединение списков по id (vars/chars при смердживании): серверные + локальные, которых нет у сервера. */
function byIdUnion(serverList: { id?: string }[], localList: { id?: string }[]): { id?: string }[] {
  const seen = new Set<string>();
  const out: { id?: string }[] = [];
  serverList.forEach((x) => {
    const k = x && x.id ? x.id : JSON.stringify(x);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x);
  });
  localList.forEach((x) => {
    const k = x && x.id ? x.id : JSON.stringify(x);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x);
  });
  return out;
}

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
