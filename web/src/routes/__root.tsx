import { createLink, createRootRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { RouteError } from '@/components/route-error';
import { BarNavItem, Sidebar, SidebarNavItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import { ThemePicker } from '@/components/ui/theme-picker';
import { useThemePreference } from '@/components/ui/theme-preference';
import { AppWindow, LayoutDashboard, ShieldCheck, UsersRound } from '@/core/app-icons';

const SidebarLink = createLink(SidebarNavItem);
const BarLink = createLink(BarNavItem);
/** Where the sign-in page lives. It is drawn without the admin shell. */
const LOGIN_PATH_PREFIX = '/login/';

/** The admin pages, in the order the sidebar lists them. */
const PLACES = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard },
  { to: '/clients', label: 'Clients', Icon: AppWindow },
  { to: '/users', label: 'Users', Icon: UsersRound },
] as const;

export const Route = createRootRoute({
  component: RootRoute,
  errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
});

/**
 * The app's mark and name, as the rail's header and the narrow bar both show it.
 */
function Brand() {
  return (
    <div className="flex items-center gap-2 px-2 py-1 font-semibold text-sm">
      <ShieldCheck className="size-4" aria-hidden />
      Heautou
    </div>
  );
}

/**
 * The app shell: the admin pages beside a sidebar. The sign-in page is drawn on its own.
 */
function RootRoute() {
  useThemePreference();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSignIn = pathname.startsWith(LOGIN_PATH_PREFIX);
  if (isSignIn) {
    return <Outlet />;
  }

  return (
    <SidebarLayout
      className="h-svh"
      sidebarPosition="start"
      sidebarWidth="auto"
      divider="none"
      sidebarHideBelow="md"
      brandSlot={<Brand />}
      navLabel="Main"
      navSlot={PLACES.map(({ to, label, Icon }) => (
        <BarLink key={to} to={to} label={label} iconSlot={<Icon />} active={pathname === to} />
      ))}
      actionSlot={<ThemePicker variant="compact" />}
      sidebarSlot={
        <Sidebar
          label="Main"
          headerSlot={<Brand />}
          contentSlot={
            <SidebarSection
              as="nav"
              label="Main"
              contentSlot={PLACES.map(({ to, label, Icon }) => (
                <SidebarLink key={to} to={to} label={label} iconSlot={<Icon />} active={pathname === to} />
              ))}
            />
          }
          footerSlot={<ThemePicker variant="compact" />}
        />
      }
      contentSlot={<Outlet />}
    />
  );
}
