import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appearanceStore } from "./lib/appearance";
import { startNekoApp } from "./lib/bootstrap";
import { AboutPage } from "./pages/about-page";
import { ChatPage } from "./pages/chat-page";
import { SettingsAppearancePage } from "./pages/settings-appearance-page";
import { SettingsContextPage } from "./pages/settings-context-page";
import { SettingsMobilePage } from "./pages/settings-mobile-page";
import { SettingsPage } from "./pages/settings-page";
import { SettingsSearchPage } from "./pages/settings-search-page";
import { SkillsPage } from "./pages/skills-page";
import "./styles.css";

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ChatPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const settingsSearchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/search",
	component: SettingsSearchPage,
});
const settingsContextRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/context",
	component: SettingsContextPage,
});
const settingsAppearanceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/appearance",
	component: SettingsAppearancePage,
});
const settingsMobileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/mobile",
	component: SettingsMobilePage,
});
const skillsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/skills", component: SkillsPage });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: "/about", component: AboutPage });
const routeTree = rootRoute.addChildren([
	chatRoute,
	settingsRoute,
	settingsSearchRoute,
	settingsContextRoute,
	settingsAppearanceRoute,
	settingsMobileRoute,
	skillsRoute,
	aboutRoute,
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

appearanceStore().start();
startNekoApp();

const container = document.getElementById("root");
if (container !== null) {
	createRoot(container).render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>,
	);
}
