/**
 * C-1 — Store global d'ouverture de la bottom sheet profil (FEN-1917 plan §2).
 *
 * Provider: monter <ProfileSheetProvider> à la RACINE du Router (router.tsx)
 * pour couvrir les deux mondes (AppShell pages ET canvas hero).
 *
 * S2 (FEN-1967) étend ce fichier pour brancher <ProfileSheet> sur `login`.
 * S3 (FEN-1968) consomme uniquement `openProfile` via `useProfileSheet`.
 */
import { createContext, useContext, useState, type ReactNode } from "react";

type ProfileSheetCtx = {
  login: string | null;
  openProfile(login: string): void;
  closeProfile(): void;
};

const ProfileSheetCtx = createContext<ProfileSheetCtx>({
  login: null,
  openProfile: () => {},
  closeProfile: () => {},
});

export function useProfileSheet(): ProfileSheetCtx {
  return useContext(ProfileSheetCtx);
}

export function ProfileSheetProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [login, setLogin] = useState<string | null>(null);
  return (
    <ProfileSheetCtx.Provider
      value={{ login, openProfile: setLogin, closeProfile: () => setLogin(null) }}
    >
      {children}
    </ProfileSheetCtx.Provider>
  );
}
