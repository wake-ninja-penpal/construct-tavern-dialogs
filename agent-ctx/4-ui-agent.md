# Task 4 — UI-слой «Ветвей» (агент: ui-agent)

## Статус: ✅ выполнено

## Что сделано

Реализован полный UI-слой коллаборативного конструктора нарратива «Ветви» поверх
готового слоя состояния `src/lib/vetvi/` (VetviStore). Файлы lib/*, package.json,
mini-services/*, next.config.ts НЕ изменялись.

### Созданные файлы
- `src/components/vetvi/VetviWorkspace.tsx` — корневой клиентский компонент:
  модульный singleton `getVetviStore()`, `useSyncExternalStore` (с getServerSnapshot
  для SSR), toast-мост `store.onToast` → модульный `toast` из use-toast
  (error → variant destructive), bootstrap + refreshCopies/refreshBackups/refreshOutbox,
  скрытый file-input для импорта JSON, компоновка header/main/диалоги.
- `src/components/vetvi/Header.tsx` — бренд «ВЕТВИ», тулбар (Новый/Открыть JSON/
  Сохранить JSON/Текст/Поделиться/Ссылка/Сделать копию/Отправить merge/К оригиналу/
  Merge-запросы с бейджем pending), статус-пилюли (режим, подключение, участники
  с Tooltip, имя пользователя с Popover → setUserName). flex-wrap — мобильные ок.
- `src/components/vetvi/LeftPanel.tsx` — добавление элементов (3 кнопки), список
  копий (открыть/удалить с AlertDialog), секция merge-запросов (incoming для
  проекта, outgoing для копии).
- `src/components/vetvi/Canvas.tsx` — холст 4000×3000 с точечной сеткой, узлы
  трёх типов (градиенты по токенам), выделение, drag через Pointer Events +
  setPointerCapture + rAF-throttle + live-обновления (updateElement live=true),
  клавиатурное выделение (role=button, Enter/Space).
- `src/components/vetvi/Inspector.tsx` — название проекта (debounce 250ms),
  свойства элемента X/Y/W/H (controlled от снапшота, live), текст с локальным
  draft + debounce 300ms + flush при blur/смене элемента/размонтировании,
  удаление с AlertDialog, статусная строка (сохранение/комната/режим копии).
- `src/components/vetvi/ShareDialog.tsx` — ссылка-приглашение (readonly + копия),
  статус, участники, отключение комнаты.
- `src/components/vetvi/MergeDialog.tsx` — входящие/исходящие merge-запросы
  (крупные карточки, Принять с подтверждением «Создать backup и применить
  изменения?», Отклонить), резервные копии с восстановлением, кнопка Обновить.
- `src/components/vetvi/shared.tsx` — общий слой: ELEMENT_LABELS, StatusPill,
  MutedPill, MergeStatusBadge, MergeRequestCard, форматтеры даты/статистики,
  `isPendingMerge()` (статус 'pending' приходит по ретранслятору и не входит в
  union MergeStatus — сравнение через String() обходит TS2367).

### Изменённые файлы
- `src/app/page.tsx` — рендерит `<VetviWorkspace />`.
- `src/app/layout.tsx` — lang="ru", metadata «Ветви — совместный конструктор
  нарратива», Toaster сохранён.
- `src/app/globals.css` — добавлен `.vetvi-scroll` (тонкий скроллбар, thumb
  #30343b, track transparent; webkit + scrollbar-width/scrollbar-color).

## Ключевые решения / отклонения от ТЗ
1. `VetviStore` импортируется как значение (не type-only) — нужен `new VetviStore()`
   в фабрике singleton; инстанс всё равно один на модуль. Все остальные компоненты
   используют `import type`.
2. Toast-мост назначается в модульной фабрике `createVetviStore()`, а не в useEffect:
   строгий react-hooks lint (react-hooks/immutability) запрещает мутировать объект,
   переданный в hook. Модульная функция `toast` из use-toast не привязана к компоненту.
3. `useSyncExternalStore` требует третий аргумент (getServerSnapshot) в Next 16 SSR —
   передан `store.getSnapshot` (до bootstrap снапшот детерминирован, ready:false).
4. Текст/X/Y/W/H коммитятся с live=true (вместо false из ТЗ): устраняет «мигание»
   controlled-инпутов из-за 60ms debounce нотификаций стора; иначе поведение идентично.
5. Локальные черновики (имя проекта, текст) без setState в effect-ах — паттерн
   draft/awaiting, проходит новый строгий eslint-plugin-react-hooks (set-state-in-effect,
   refs, immutability).
6. Сетка main: `md:grid-rows-[minmax(0,1fr)]` — иначе авто-ряд растягивается на
   3000px содержимого холста.
7. prototype_ref.html в репозитории отсутствует — использованы дизайн-токены из ТЗ.

## Проверки
- `bunx tsc --noEmit` — ошибок в файлах vetvi нет (только предсуществующие в
  examples/, skills/ — вне зоны задачи).
- `bun run lint` — 0 ошибок, 0 предупреждений.
- `GET / → 200`, SSR отдаёт loading-состояние, гидрация консистентна.
- dev.log: предупреждение «Yjs was already imported» — исходит из существующего
  lib-слоя/провайдера, к UI не относится.
