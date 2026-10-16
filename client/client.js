/**
 * dsh-notify — browser half (lazy-CJS client bundle).
 *
 * The host half answers approvals and questions in Discord. This half answers the
 * other half of "you are not looking at it": when a turn ends while the window is
 * in the background, it shows a desktop notification naming the task and how it
 * ended, and clicking it brings the window back.
 *
 * The signal is the Host's own running flag in the session list — the flag the
 * sidebar already draws — so nothing here depends on reading the transcript. The
 * `turn/end` reason is read from the session binding when a view retains it, which
 * is the case for every session a person can be waiting on; without a binding the
 * notification still fires, with a neutral status word.
 *
 * Notifications need a permission a browser only grants from a user gesture, so
 * this half also owns the Settings page that asks for it.
 */

window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		//#region styles
		const CSS_ID = "dsh-notify/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_ID);
			tag.textContent = [
				".dshn_root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;max-width:640px}",
				".dshn_card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-secondary);border-radius:12px;background:var(--dsw-alias-bg-elevated)}",
				".dshn_title{font-weight:600;font-size:14px}",
				".dshn_desc{color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
				".dshn_row{display:flex;gap:8px}",
				".dshn_key{color:var(--dsw-alias-label-tertiary);min-width:96px}",
				".dshn_val{color:var(--dsw-alias-label-secondary);word-break:break-all}",
				".dshn_actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
				".dshn_hint{color:var(--dsw-alias-label-tertiary);font-size:12px}",
				".dshn_state{font-size:12px;color:var(--dsw-alias-label-tertiary)}"
			].join("");
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locale
		const NS = "dshNotify";
		/** @type {Record<string, string>} */
		const zh = {
			nav: "完成通知",
			heading: "本机通知",
			intro: "一轮回答结束时，如果窗口不在前台，就在本机弹一条通知。Discord 那一侧由宿主半侧负责，和这里各自独立。",
			permission: "浏览器权限",
			granted: "已允许",
			denied: "已被拒绝（需要在浏览器的站点设置里改回来）",
			ask: "尚未询问",
			enable: "启用通知",
			enableHint: "浏览器要求由你的点击来授予权限，所以这一下必须你来点。",
			osHint: "如果这里已允许、点了测试却没弹：系统的「通知」设置里要允许浏览器，专注模式／免打扰也会压掉它。",
			test: "发一条测试通知",
			testBody: "测试：这条是 dsh-notify 发的",
			unsupported: "这个浏览器没有 Notification 接口，本机通知不可用。",
			body: "状态：{status}",
			statusCompleted: "完成",
			statusBlocked: "等待你处理",
			statusAborted: "被中断",
			statusError: "出错",
			statusOther: "已结束",
		};
		/** @type {Record<string, string>} */
		const en = {
			nav: "Completion notices",
			heading: "Local notifications",
			intro: "When a turn ends while this window is in the background, show a notification on this machine. The Discord side is the host half's job and works independently.",
			permission: "Browser permission",
			granted: "granted",
			denied: "denied (change it in the browser's site settings)",
			ask: "not asked yet",
			enable: "Enable notifications",
			enableHint: "Browsers only grant this from your own click, so this one is yours to press.",
			osHint: "Granted here but the test shows nothing? The system's own notification settings must allow the browser, and Focus/Do Not Disturb suppresses them.",
			test: "Send a test notification",
			testBody: "Test: this one came from dsh-notify",
			unsupported: "This browser has no Notification interface, so local notices are unavailable.",
			body: "Status: {status}",
			statusCompleted: "completed",
			statusBlocked: "waiting for you",
			statusAborted: "interrupted",
			statusError: "failed",
			statusOther: "finished",
		};
		//#endregion

		//#region notifications
		/** `turn/end` reason kinds to dictionary keys. */
		const STATUS_KEYS = {
			completed: "statusCompleted",
			blocked: "statusBlocked",
			aborted: "statusAborted",
			error: "statusError",
		};

		/** Whether this browser can show a notification at all. */
		const supported = () => typeof Notification !== "undefined";

		/**
		 * Whether the window is in front of the person right now.
		 *
		 * Focus, not tab visibility: on a desktop, clicking another application or
		 * another window leaves this tab `visible`, and that is exactly the moment a
		 * completion notice is wanted. Hidden is the fallback for a document that
		 * cannot report focus.
		 * @returns true when the window has focus and the notice would be redundant.
		 */
		const inFront = () => (typeof document.hasFocus === "function"
			? document.hasFocus()
			: document.visibilityState === "visible");

		/**
		 * Show one notification, unless the window is in front of the person already.
		 *
		 * `requireInteraction` is what keeps it there: a page-created notification is
		 * otherwise withdrawn by the browser as soon as its tab becomes active again,
		 * which is exactly when someone comes back to read it.
		 * @param t - this namespace's translate function.
		 * @param title - the notification heading: which task this is.
		 * @param body - the notification text.
		 * @param tag - replaces an earlier notification for the same session instead of stacking.
		 * @returns whether a notification was shown.
		 */
		function show(t, title, body, tag) {
			if (!supported() || Notification.permission !== "granted") return false;
			const notice = new Notification(title, { body, tag: `dsh-notify:${tag}`, requireInteraction: true });
			notice.onclick = () => {
				window.focus();
				notice.close();
			};
			return true;
		}
		//#endregion

		//#region settings page
		/**
		 * The Settings page: the permission state, the button that asks for it, and a
		 * test that proves the whole path works before a long task depends on it.
		 * @param props - the slot's props, carrying this namespace's translate function.
		 * @returns the page element.
		 */
		function NotifySection({ t }) {
			const [permission, setPermission] = React.useState(supported() ? Notification.permission : "unsupported");
			const [notice, setNotice] = React.useState("");

			const ask = async () => {
				if (!supported()) return;
				const result = await Notification.requestPermission();
				setPermission(result);
				if (result === "granted") setNotice(t("granted"));
			};
			const test = () => {
				const shown = show(t, t("nav"), t("testBody"), "test");
				setNotice(shown ? "" : t("ask"));
			};

			const state = permission === "granted" ? t("granted")
				: permission === "denied" ? t("denied")
					: permission === "unsupported" ? t("unsupported")
						: t("ask");

			return React.createElement("div", { className: "dshn_root" },
				React.createElement("div", { className: "dshn_title" }, t("heading")),
				React.createElement("div", { className: "dshn_desc" }, t("intro")),
				React.createElement("div", { className: "dshn_row" },
					React.createElement("span", { className: "dshn_key" }, t("permission")),
					React.createElement("span", { className: "dshn_val" }, state),
				),
				React.createElement("div", { className: "dshn_actions" },
					React.createElement("button", { type: "button", onClick: ask, disabled: !supported() }, t("enable")),
					React.createElement("button", { type: "button", onClick: test, disabled: permission !== "granted" }, t("test")),
				),
				React.createElement("div", { className: "dshn_hint" }, t("enableHint")),
				React.createElement("div", { className: "dshn_hint" }, t("osHint")),
				notice === "" ? null : React.createElement("div", { className: "dshn_state" }, notice),
			);
		}
		//#endregion

		//#region wiring
		const inject = ["sessions", "locale", "slots"];

		/**
		 * Watch every session the Host reports, and notify when one stops running
		 * while this window is in the background.
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-notify: dictionaries");
			const t = ctx.locale.bind(NS);

			ctx.effect(() => {
				/** Last observed running flag per session. */
				const running = new Map();
				/** Last `turn/end` reason per session, when a binding was available. */
				const reasons = new Map();
				/** Live binding subscriptions, keyed by session. */
				const stops = new Map();

				const bind = (id) => {
					if (stops.has(id)) return;
					const binding = ctx.sessions.binding(id);
					if (binding === undefined) return;
					stops.set(id, binding.eventSource.subscribe(() => {
						const { change } = binding.eventSource.getSnapshot();
						if (change.kind !== "append") return;
						for (const { event } of change.entries) {
							if (event.type === "turn/end") reasons.set(id, event.data?.reason);
						}
					}));
				};

				const observe = () => {
					const { ids, byId } = ctx.sessions.list.getSnapshot();
					for (const id of ids) {
						bind(id);
						const isRunning = byId[id]?.running === true;
						const was = running.get(id);
						running.set(id, isRunning);
						if (was !== true || isRunning) continue;
						if (inFront()) continue;
						const key = STATUS_KEYS[reasons.get(id)?.kind] ?? "statusOther";
						show(t, byId[id]?.displayTitle ?? id, t("body", { status: t(key) }), id);
					}
				};

				const stopList = ctx.sessions.list.subscribe(observe);
				observe();
				return () => {
					stopList();
					for (const stop of stops.values()) stop();
				};
			}, "dsh-notify: completion notices");

			ctx.slots.inject("settings.section", () => {
				const dispose = ctx.slots.register({
					name: "settings.section",
					id: "dsh-notify",
					order: 91,
					label: () => t("nav"),
					locale: NS,
				}, NotifySection);
				return () => { dispose(); };
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		//#endregion

		return module.exports;
	}
});
