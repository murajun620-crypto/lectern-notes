import { useCallback, useEffect, useState } from 'react';
import type { AccountInfo } from '@azure/msal-browser';
import { createOneDriveClient } from './oneDrive';

const clientId = import.meta.env.VITE_ONEDRIVE_CLIENT_ID?.trim() as string | undefined;
const authority: string =
  import.meta.env.VITE_ONEDRIVE_AUTHORITY?.trim() ||
  'https://login.microsoftonline.com/organizations';
const configured = Boolean(clientId);
const guidPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const allowedAuthority = new RegExp(
  `^https://login\\.microsoftonline\\.com/(common|consumers|organizations|${guidPattern})/?$`,
  'i',
);
const scopes = ['https://graph.microsoft.com/Files.ReadWrite'];

function accountId(account: AccountInfo) {
  return `${account.homeAccountId}/${account.tenantId}`;
}

async function loadAuth() {
  if (!clientId || !new RegExp(`^${guidPattern}$`, 'i').test(clientId)) {
    throw new Error('OneDrive連携のMicrosoftアプリ登録を確認してください。');
  }
  if (!allowedAuthority.test(authority)) {
    throw new Error('OneDrive連携のMicrosoftログイン先を確認してください。');
  }
  const sdk = await import('@azure/msal-browser');
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  const app = new sdk.PublicClientApplication({
    auth: {
      clientId,
      authority,
      redirectUri: new URL('onedrive-redirect.html', base).href,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await app.initialize();
  let redirectError = '';
  try {
    const result = await app.handleRedirectPromise();
    if (result?.account) app.setActiveAccount(result.account);
  } catch (error) {
    redirectError = signInError(error);
  }
  if (!app.getActiveAccount()) {
    const accounts = app.getAllAccounts();
    if (accounts.length === 1) app.setActiveAccount(accounts[0]);
  }
  return { app, sdk, redirectError };
}

let loading: ReturnType<typeof loadAuth> | undefined;
function getAuth() {
  loading ??= loadAuth().catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

function signInError(error: unknown) {
  const code = (error as { errorCode?: string } | null)?.errorCode;
  if (code === 'access_denied' || code === 'user_cancelled') {
    return 'MicrosoftへのサインインまたはOneDriveへのアクセスを許可できませんでした。';
  }
  return 'Microsoftにサインインできませんでした。アカウントと組織のアクセス許可を確認し、もう一度お試しください。';
}

type OneDriveAccount = { id: string; label: string };
function displayAccount(account: AccountInfo | null): OneDriveAccount | null {
  return (
    account && { id: accountId(account), label: account.username || account.name || 'Microsoft' }
  );
}

export function useOneDriveAuth() {
  const [account, setAccount] = useState<OneDriveAccount | null>(null);
  const [ready, setReady] = useState(!configured);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!configured) return;
    let active = true;
    void getAuth().then(
      ({ app, redirectError }) => {
        if (!active) return;
        setAccount(displayAccount(app.getActiveAccount()));
        setError(redirectError);
        setReady(true);
      },
      (failure: unknown) => {
        if (!active) return;
        setError(
          failure instanceof Error && !('errorCode' in failure)
            ? failure.message
            : signInError(failure),
        );
        setReady(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const signIn = async () => {
    const { app } = await getAuth();
    setError('');
    try {
      await app.loginRedirect({ scopes, prompt: 'select_account' });
    } catch (failure) {
      throw new Error(signInError(failure));
    }
  };

  const signOut = async () => {
    const { app } = await getAuth();
    await app.clearCache();
    setAccount(null);
    setError('');
  };

  const getClient = useCallback(async () => {
    const { app, sdk } = await getAuth();
    const user = app.getActiveAccount();
    if (!user) throw new Error('OneDriveを使うにはMicrosoftにサインインしてください。');
    const id = accountId(user);
    return {
      accountId: id,
      client: createOneDriveClient(async () => {
        const active = app.getActiveAccount();
        if (!active || accountId(active) !== id) {
          throw new Error('このファイルを開いたMicrosoftアカウントにサインインしてください。');
        }
        try {
          const result = await app.acquireTokenSilent({
            account: active,
            scopes,
            // Safari can block cross-site cookies in an iframe. Use an explicit login when the
            // cached refresh token can no longer renew the session.
            cacheLookupPolicy: sdk.CacheLookupPolicy.AccessTokenAndRefreshToken,
          });
          return result.accessToken;
        } catch (failure) {
          if (failure instanceof sdk.InteractionRequiredAuthError) {
            throw new Error('OneDriveとの接続が切れました。Microsoftに再サインインしてください。');
          }
          throw new Error('OneDriveに接続できませんでした。通信を確認してもう一度お試しください。');
        }
      }),
    };
  }, []);

  return { configured, ready, account, error, signIn, signOut, getClient };
}
