import { createLink, createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { RouteError } from '@/components/route-error';
import { BarNavItem, Sidebar, SidebarNavItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import { Button } from '@/components/ui/button';
import { Ellipsis, Monitor, Moon, Settings, Sun, UserRound } from '@/components/ui/icons';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { ThemePicker } from '@/components/ui/theme-picker';
import { useThemePreference } from '@/components/ui/theme-preference';
import { isThemePreference, type ThemePreference } from '@/components/ui/theme-preference-base';
import { useAccount } from '@/core/account';
import { signOut, useViewer } from '@/core/admin';
import { Activity, AppWindow, LayoutDashboard, LogOut, Server, ShieldCheck, Tags, UsersRound } from '@/core/app-icons';
import { BrandIcon, useBrandName } from '@/core/brand';

const SidebarLink = createLink(SidebarNavItem);
const BarLink = createLink(BarNavItem);
/**
 * The pages the provider sends a browser to: sign in, sign out, signed out, errors and the device flow, the first-admin setup, and
 * a password link. They are for whoever is signing in to an app, not only admins, so they are drawn without the admin
 * shell.
 */
const PROVIDER_PAGES = ['/login/', '/logout', '/logged-out', '/error', '/device', '/setup', '/set-password'];

/** A user's own account page, which an admin sees inside the admin shell and anyone else on its own. */
const ACCOUNT_PAGE = '/account';

/** The admin pages, in the order the sidebar lists them. */
const PLACES = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard, isInBar: true },
  { to: '/clients', label: 'Clients', Icon: AppWindow, isInBar: true },
  { to: '/apis', label: 'APIs', Icon: Server, isInBar: false },
  { to: '/users', label: 'Users', Icon: UsersRound, isInBar: true },
  { to: '/groups', label: 'Groups', Icon: Tags, isInBar: false },
  { to: '/sites', label: 'Protected sites', Icon: ShieldCheck, isInBar: true },
  { to: '/activity', label: 'Activity', Icon: Activity, isInBar: false },
  { to: '/settings', label: 'Settings', Icon: Settings, isInBar: false },
] as const;

/** The theme choices the narrow bar's menu offers, in its order. */
const THEMES = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const satisfies readonly { value: ThemePreference; label: string; Icon: unknown }[];

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
 * The narrow bar's menu: the places the bar has no room for, the user's own page, the theme and signing out.
 *
 * @param props - What the sign-out row says.
 * @param props.signOutLabel - The sign-out row's label, naming who is signed in.
 */
function NarrowMenu({ signOutLabel }: { signOutLabel: string }) {
  const [theme, setTheme] = useThemePreference();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="More" iconSlot={<Ellipsis />} />
      </MenuTrigger>
      <MenuContent align="end" aria-label="More">
        {PLACES.filter((place) => place.isInBar === false).map(({ to, label, Icon }) => (
          <MenuItem key={to} iconSlot={<Icon />} label={label} linkSlot={<Link to={to} />} />
        ))}
        <MenuSeparator />
        <MenuItem iconSlot={<UserRound />} label="My account" linkSlot={<Link to="/account" />} />
        <MenuSeparator />
        <MenuRadioGroup
          aria-label="Theme"
          value={theme}
          onValueChange={(next) => {
            if (isThemePreference(next)) {
              setTheme(next);
            }
          }}
        >
          {THEMES.map(({ value, label, Icon }) => (
            <MenuRadioItem key={value} value={value} label={label} iconSlot={<Icon />} />
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem iconSlot={<LogOut />} label={signOutLabel} onSelect={signOut} />
      </MenuContent>
    </Menu>
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
  if (pathname.startsWith(ACCOUNT_PAGE)) {
    return <AccountShell pathname={pathname} />;
  }
  return <AdminShell pathname={pathname} />;
}

/**
 * The account page: in the admin shell for an admin, so they keep their place, and on its own for anyone else.
 *
 * @param props - The current path, to mark the active page.
 * @param props.pathname - The router's pathname.
 */
function AccountShell({ pathname }: { pathname: string }) {
  const account = useAccount();
  if (account.isPending) {
    return null;
  }
  // A failed read falls through to the page itself, which says what went wrong.
  return account.data?.isAdmin ? (
    <AdminShell pathname={pathname} />
  ) : (
    <div className="h-svh">
      <Outlet />
    </div>
  );
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
      navSlot={PLACES.filter((place) => place.isInBar).map(({ to, label, Icon }) => (
        <BarLink key={to} to={to} label={label} iconSlot={<Icon />} active={pathname === to} />
      ))}
      actionSlot={<NarrowMenu signOutLabel={signOutLabel} />}
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
              <SidebarLink
                to="/account"
                label="My account"
                iconSlot={<UserRound />}
                active={pathname === ACCOUNT_PAGE}
              />
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
