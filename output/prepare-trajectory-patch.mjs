import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve('extensions/aspera')
const store = resolve(root, 'node_modules/.pnpm')
const req = createRequire(resolve(store, readdirSync(store).find(n => n.startsWith('@deepseek-ai+dsh-web-app@')), 'node_modules/@deepseek-ai/dsh-web-app/package.json'))
function change(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Pinned DSH patch anchor: ' + before.slice(0, 110))
  return text.replace(before, after)
}
function patch(pkg, edits) {
  const path = req.resolve('@deepseek-ai/'+pkg+'/client')
  const work = resolve('output', pkg); mkdirSync(work, {recursive:true})
  const old = readFileSync(existsSync(resolve(work,'old.js')) ? resolve(work,'old.js') : path, 'utf8')
  const fresh = edits(old)
  writeFileSync(resolve(work,'old.js'), old); writeFileSync(resolve(work,'new.js'), fresh)
  const result = spawnSync('git', ['diff','--no-index','--no-ext-diff','--','old.js','new.js'], {cwd:work,encoding:'utf8'})
  if (result.status !== 1) throw new Error(result.stderr)
  const diff=result.stdout.replace(/^diff --git.*\nindex.*\n/m,'').replace('--- a/old.js','--- a/lib/client.js').replace('+++ b/new.js','+++ b/lib/client.js')
  writeFileSync(resolve(root,'patches',pkg+'-0.2.0-rc.2.patch'),diff)
  // pnpm install applies the exact same reviewed patch to clean package instances.
}
patch('dsh-client-ui-conversation', text => change(text, '\t\t\tbinding(source) {', `			/** Assemble an externally owned, read-only event feed. The caller disposes it. */
			bindReadonly(feed) {
				const binding = new BoundConversation(feed, new ConversationNodeAssembler(this.events, this.views, this.groups));
				const rebuild = () => binding.rebuild();
				const disposers = [this.events.subscribe(rebuild), this.views.subscribe(rebuild), this.groups.subscribe(rebuild)];
				return { target: target => binding.target(target), dispose: () => { disposers.forEach(dispose => dispose()); binding.dispose(); } };
			}
			binding(source) {`))
patch('dsh-client-ui-trajectory', text => {
  text=change(text,'function TrajectoryView({ useSession,','function TrajectoryView({ readonly = false, toolbar, onSelection, onReadingChange, useSession,')
  text=change(text,'const [actualTime, setActualTime] = (0, react.useState)(false);','const [actualTime, setActualTime] = (0, react.useState)(readonly);')
  text=change(text,'function TrajectoryToolbar({ actualDuration,','function TrajectoryToolbar({ toolbar, actualDuration,')
  text=change(text,'className: TrajectoryToolbar_module_css_default.search,','className: TrajectoryToolbar_module_css_default.search,') // validate the anchor before the insertion below
  const search='}), (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\t\tclassName: TrajectoryToolbar_module_css_default.search,'
  text=change(text,search,'}), toolbar, (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\t\tclassName: TrajectoryToolbar_module_css_default.search,')
  text=change(text,'\t\t\t\t\t\tsearchQuery,','\t\t\t\t\t\ttoolbar,\n\t\t\t\t\t\tsearchQuery,')
  text=change(text,'function TrajectoryTable({ t,','function TrajectoryTable({ onVisibleIndex, onSelection, onReadingChange, t,')
  text=change(text,'onSelectedIndexChange?.(selectedIndex);','onSelectedIndexChange?.(selectedIndex);\n\t\t\t\tonSelection?.(selected?.cell ?? null);')
  text=change(text,'requestOlder(pane, true);',`requestOlder(pane, true);
                        onReadingChange?.(pane.scrollHeight - pane.clientHeight - pane.scrollTop > 64);
						if (onVisibleIndex) requestAnimationFrame(() => {
							if (!pane.isConnected || !pane.clientHeight) return;
							const top = pane.getBoundingClientRect().top;
							const first = [...pane.querySelectorAll('[data-record-index]')].find(row => row.getBoundingClientRect().bottom > top + 1);
							if (first) onVisibleIndex(Number(first.dataset.recordIndex));
						});`)
  text=change(text,'onSelectedIndexChange: setSelectedTimelineIndex,','onSelectedIndexChange: setSelectedTimelineIndex,\n\t\t\t\t\t\t\tonVisibleIndex: readonly ? setSelectedTimelineIndex : undefined,\n\t\t\t\t\t\t\tonSelection, onReadingChange,')
  text=change(text,'(0, react_jsx_runtime.jsx)(TrajectoryTimeline, {','(0, react_jsx_runtime.jsx)(readonly ? ReadonlyTimeline : TrajectoryTimeline, {')
  text=change(text,'\t\t\t\trecords,\n\t\t\t\trowVirtualizer,\n\t\t\t\tvirtualIndexByRecordId,\n\t\t\t\tvirtualizationEnabled\n',
    '\t\t\t\trecords,\n\t\t\t\trowVirtualizer,\n\t\t\t\tvirtualIndexByRecordId,\n\t\t\t\tonVisibleIndex ? recordFocus : null,\n\t\t\t\tvirtualizationEnabled\n')
  const bridge=`
		/** Read-only factory uses the same assembler, timeline, ledger, and inspector as ordinary Sessions. */
		function ReadonlyTrajectory({ feed, paging, loadOlder, toolbar, onSelection, onReadingChange, loadImage, renderFactorySlot, t }) {
			const owner = (0, react.useContext)(ReadonlyTrajectoryContext);
			const [binding, setBinding] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				const next = owner.uiConversation.bindReadonly(feed); setBinding(next);
				return () => next.dispose();
			}, [owner, feed]);
			const [duration] = (0, react.useState)(() => createTrajectoryDurationStore());
			const target = (0, react.useMemo)(() => binding?.target('trajectory'), [binding]);
			const useSource = source => selector => selector((0, react.useSyncExternalStore)(source.subscribe, source.getSnapshot));
			if (!target) return null;
			const trajectory = { subscribe: target.subscribe, getSnapshot: () => target.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT };
			return (0, react_jsx_runtime.jsx)(TrajectoryView, { readonly: true, toolbar, onSelection, onReadingChange, t,
				useSession: useSource(paging), useTrajectory: useSource(trajectory), useDuration: useSource(duration),
				loadOlder, loadImage,
				renderSlot: (_name, props) => renderFactorySlot('attachments.readonlyImages', props), setActualDuration: value => duration.set(value), viewRequest: null, completeViewRequest: () => {} });
		}
		const ReadonlyTrajectoryContext = (0, react.createContext)(null);
		/** Pan the official timeline and focus the ledger by event index without filtering events. */
		function ReadonlyTimeline(props) {
			const ref = (0, react.useRef)(null);
			const syncing = (0, react.useRef)(null);
			const model = (0, react.useMemo)(() => deriveTrajectoryTimeline(props.turns, props.mode), [props.turns, props.mode]);
			const width = Math.max(1000, (model?.spans.length ?? 0) * 26);
			(0, react.useEffect)(() => {
				const pane=ref.current, span=model?.spans.find(span => span.index === props.selectedIndex);
				if (!pane || !span) return;
				const x=(span.start-model.start)/Math.max(1,model.end-model.start)*pane.scrollWidth;
				if (x < pane.scrollLeft || x > pane.scrollLeft+pane.clientWidth) {
					const target=Math.min(pane.scrollWidth-pane.clientWidth,Math.max(0,x-50));
					if (Math.abs(pane.scrollLeft-target)>1) { syncing.current=target; pane.scrollLeft=target; }
				}
			}, [model, props.selectedIndex]);
			const times=props.turns.flatMap(turn => turn.groups.flatMap(group => group.cells)).map(cell => cell.startedAt).filter(value => typeof value === 'number');
			const start=times.length ? Math.min(...times) : null, end=times.length ? Math.max(...times) : null;
			const format=time => time === null ? '—' : new Date(time).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
			return (0, react_jsx_runtime.jsx)('div', { ref, 'data-readonly-timeline':'', style:{overflowX:'scroll',overflowY:'hidden',flexShrink:0},
				onScroll: event => {
					const automatic=syncing.current; syncing.current=null;
					if (automatic !== null && Math.abs(event.currentTarget.scrollLeft-automatic)<1) return;
					if (!model?.spans.length) return;
					const pane=event.currentTarget, time=model.start+pane.scrollLeft/pane.scrollWidth*(model.end-model.start);
					const span=model.spans.reduce((a,b) => Math.abs(b.start-time)<Math.abs(a.start-time) ? b : a);
					props.onRecordFocus?.(span.index);
				}, children:(0, react_jsx_runtime.jsxs)('div',{style:{minWidth:width,width:'100%'},children:[
					(0,react_jsx_runtime.jsxs)('div',{style:{display:'flex',justifyContent:'space-between',font:'var(--dsw-font-xxs-12)',color:'var(--dsw-alias-label-secondary)',padding:'2px 12px 0 52px'},children:[(0,react_jsx_runtime.jsx)('span',{children:format(start)}),(0,react_jsx_runtime.jsx)('span',{children:format(end)})]}),
					(0,react_jsx_runtime.jsx)(TrajectoryTimeline,props)]}) });
		}
`
  text=change(text,'\t\tfunction apply(ctx) {',bridge+'\n\t\tfunction apply(ctx) {')
  text=change(text,'\t\t\tregisterTrajectoryConversationView(ctx);',`			registerTrajectoryConversationView(ctx);
			ctx.slots.registerFactory({ name:'trajectory.readonly', scope:'root', locale:NS }, props =>
				(0,react_jsx_runtime.jsx)(ReadonlyTrajectoryContext.Provider,{value:ctx,children:(0,react_jsx_runtime.jsx)(ReadonlyTrajectory,props)}));`)
  return text
})
patch('dsh-client-ui-attachment', text => change(text, '\t\tfunction apply(ctx) {', `\t\tfunction apply(ctx) {
            ctx.slots.registerFactory({name:'attachments.readonlyImages', scope:'root', locale:'conversation'}, MessageImages);`))
