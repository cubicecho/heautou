import { createLink, createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { RouteError } from '@/components/route-error';
import { BarNavItem, Sidebar, SidebarNavItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import { Button } from '@/components/ui/button';
import { Settings, UserRound } from '@/components/ui/icons';
import { ThemePicker } from '@/components/ui/theme-picker';
import { useThemePreference } from '@/components/ui/theme-preference';
import { signOut, useViewer } from '@/core/admin';
import { Activity, AppWindow, LayoutDashboard, LogOut, Server, Tags, UsersRound } from '@/core/app-icons';
import { BrandIcon, useBrandName } from '@/core/brand';

const SidebarLink = createLink(SidebarNavItem);
const BarLink = createLink(BarNavItem);
/**
 * The pages the provider sends a browser to: sign in, sign out, signed out and errors, the first-admin setup, and
 * a user's own account and password link. They are for whoever is signing in to an app, not only admins, so they
 * are drawn without the admin shell.
 */
const PROVIDER_PAGES = ['/login/', '/logout', '/logged-out', '/error', '/setup', '/account', '/set-password'];

/** The admin pages, in the order the sidebar lists them. */
const PLACES = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard },
  { to: '/clients', label: 'Clients', Icon: AppWindow },
  { to: '/apis', label: 'APIs', Icon: Server },
  { to: '/users', label: 'Users', Icon: UsersRound },
  { to: '/groups', label: 'Groups', Icon: Tags },
  { to: '/activity', label: 'Activity', Icon: Activity },
  { to: '/settings', label: 'Settings', Icon: Settings },
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
      <BrandIcon className="size-4" />
      {useBrandName()}
    </div>
  );
}

/**
 * The narrow bar's way to the signed-in user's own page.
 */
function AccountLink() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="My account"
      iconSlot={<UserRound />}
      linkSlot={<Link to="/account" />}
    />
  );
}

/**
 * The app shell: the admin pages beside a sidebar. The sign-in page is drawn on its own.
 */
function RootRoute() {
  useThemePreference();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isProviderPage = PROVIDER_PAGES.some((page) => pathname.startsWith(page));
  if (isProviderPage) {
    return <Outlet />;
  }
  return <AdminShell pathname={pathname} />;
}

/**
 * The admin pages beside a sidebar, with who is signed in and a way out. Its first request signs the
 * browser in when there is no admin session.
 *
 * @param props - The current path, to mark the active page.
 * @param props.pathname - The router's pathname.
 */
function AdminShell({ pathname }: { pathname: string }) {
  const viewer = useViewer();
  const signOutLabel = viewer.data === undefined ? 'Sign out' : `Sign out ${viewer.data.username}`;

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
      actionSlot={
        <div className="flex items-center gap-1">
          <ThemePicker variant="compact" />
          <AccountLink />
          <Button variant="ghost" size="icon-sm" aria-label={signOutLabel} iconSlot={<LogOut />} onClick={signOut} />
        </div>
      }
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
          footerSlot={
            <>
              <SidebarLink to="/account" label="My account" iconSlot={<UserRound />} active={false} />
              <SidebarNavItem label={signOutLabel} iconSlot={<LogOut />} onClick={signOut} />
              <ThemePicker variant="compact" />
            </>
          }
        />
      }
      contentSlot={<Outlet />}
    />
  );
}
