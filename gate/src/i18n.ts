// The sign-in pages speak the browser's language when it is French, English
// otherwise. One table per language, the same keys in both: a missing key falls
// back to English rather than showing its name.
const en = {
  signIn: "Sign in",
  signInTo: "Sign in to open {app}.",
  signInConsole: "Confirm your identity to securely access your server’s administration.",
  signInWelcome: "Your applications, all in one place.",
  passkeyHint: "Use your fingerprint, face, or device PIN.",
  login: "Username or email",
  password: "Password",
  submitSignIn: "Sign in",
  usePasskey: "Sign in with a passkey",
  or: "or",
  wrongCredentials: "Wrong username or password.",
  tooMany: "Too many attempts. Try again in {s} seconds.",
  passkeyFailed: "The passkey could not be used. Try again, or use your password.",
  noPasskeySupport: "This browser cannot use passkeys.",
  welcomeTitle: "Welcome, {name}",
  welcomeBody: "Choose a password to finish setting up your account, or create a passkey instead.",
  resetTitle: "New password for {name}",
  resetBody: "Choose a new password. Every device signed in to this account is signed out.",
  setupTitle: "Create the administrator account",
  setupBody: "This account will manage the whole server. Pick a password you do not use anywhere else.",
  username: "Username",
  displayName: "Your name",
  emailOptional: "Email (optional)",
  newPassword: "New password",
  confirmPassword: "Confirm the password",
  saveContinue: "Save and continue",
  createPasskeyInstead: "Create a passkey instead",
  linkInvalid: "This link has expired or was already used. Ask an administrator for a new one.",
  pwTooShort: "Use at least 10 characters.",
  pwTooLong: "Use at most 200 characters.",
  pwTooCommon: "This password is too easy to guess.",
  pwMismatch: "The two passwords are different.",
  usernameInvalid: "Lowercase letters, digits, dots, dashes and underscores, 2 to 32 characters.",
  usernameTaken: "This username is already taken.",
  nameRequired: "Your name is required.",
  accountTitle: "Your account",
  signedInAs: "Signed in as {name}",
  adminBadge: "admin",
  yourApps: "Your apps",
  noApps: "No app is open to you yet.",
  rolesIn: "roles: {roles}",
  passwordTitle: "Password",
  currentPassword: "Current password",
  changePassword: "Change the password",
  setPassword: "Set a password",
  noPassword: "No password: you sign in with a passkey.",
  wrongCurrent: "The current password is wrong.",
  passwordSaved: "Password saved.",
  passkeysTitle: "Passkeys",
  passkeysNote: "A passkey signs you in with your fingerprint, face or device PIN. Nothing to remember, nothing to phish.",
  noPasskeys: "No passkey yet.",
  passkeyLabel: "Name of this device (e.g. phone)",
  addPasskey: "Add a passkey",
  remove: "Remove",
  lastCredential: "Keep at least one way to sign in.",
  lastUsed: "last used {when}",
  neverUsed: "never used",
  keysTitle: "Access keys",
  keysNote: "A key acts as you on the apps it allows, for scripts and tools. It expires after 90 days and never opens the console.",
  noKeys: "No access key.",
  keyLabel: "What it is for",
  keyApps: "Valid for",
  allMyApps: "all my apps",
  createKey: "Create a key",
  keyShownOnce: "Copy it now, it will not be shown again:",
  keyExpires: "expires {when}",
  signOut: "Sign out",
  privacyNote: "Administrators of this server can see which apps you open and on which days. Nothing more detailed is kept.",
  forbiddenTitle: "Not allowed",
  forbiddenBody: "You are signed in as {name}, but this needs something your account does not have: {reason}.",
  backToAccount: "Your account",
  otherAccount: "Use another account",
};

const fr: typeof en = {
  signIn: "Connexion",
  signInTo: "Connectez-vous pour ouvrir {app}.",
  signInConsole: "Confirmez votre identité pour accéder à l’administration de votre serveur en toute sécurité.",
  signInWelcome: "Vos applications, au même endroit. Tout simplement.",
  passkeyHint: "Utilisez votre empreinte, votre visage ou le code de votre appareil.",
  login: "Nom d'utilisateur ou email",
  password: "Mot de passe",
  submitSignIn: "Se connecter",
  usePasskey: "Utiliser une clé d’accès",
  or: "ou",
  wrongCredentials: "Nom d'utilisateur ou mot de passe incorrect.",
  tooMany: "Trop de tentatives. Réessayez dans {s} secondes.",
  passkeyFailed: "La passkey n'a pas pu être utilisée. Réessayez, ou utilisez votre mot de passe.",
  noPasskeySupport: "Ce navigateur ne sait pas utiliser les passkeys.",
  welcomeTitle: "Bienvenue, {name}",
  welcomeBody: "Choisissez un mot de passe pour terminer la création de votre compte, ou créez plutôt une passkey.",
  resetTitle: "Nouveau mot de passe pour {name}",
  resetBody: "Choisissez un nouveau mot de passe. Tous les appareils connectés à ce compte seront déconnectés.",
  setupTitle: "Créer le compte administrateur",
  setupBody: "Ce compte gérera tout le serveur. Choisissez un mot de passe que vous n'utilisez nulle part ailleurs.",
  username: "Nom d'utilisateur",
  displayName: "Votre nom",
  emailOptional: "Email (facultatif)",
  newPassword: "Nouveau mot de passe",
  confirmPassword: "Confirmez le mot de passe",
  saveContinue: "Enregistrer et continuer",
  createPasskeyInstead: "Créer une passkey à la place",
  linkInvalid: "Ce lien a expiré ou a déjà servi. Demandez-en un nouveau à un administrateur.",
  pwTooShort: "Au moins 10 caractères.",
  pwTooLong: "Au plus 200 caractères.",
  pwTooCommon: "Ce mot de passe est trop facile à deviner.",
  pwMismatch: "Les deux mots de passe sont différents.",
  usernameInvalid: "Minuscules, chiffres, points, tirets et soulignés, de 2 à 32 caractères.",
  usernameTaken: "Ce nom d'utilisateur est déjà pris.",
  nameRequired: "Votre nom est obligatoire.",
  accountTitle: "Votre compte",
  signedInAs: "Connecté en tant que {name}",
  adminBadge: "admin",
  yourApps: "Vos apps",
  noApps: "Aucune app ne vous est encore ouverte.",
  rolesIn: "rôles : {roles}",
  passwordTitle: "Mot de passe",
  currentPassword: "Mot de passe actuel",
  changePassword: "Changer le mot de passe",
  setPassword: "Définir un mot de passe",
  noPassword: "Pas de mot de passe : vous vous connectez avec une passkey.",
  wrongCurrent: "Le mot de passe actuel est incorrect.",
  passwordSaved: "Mot de passe enregistré.",
  passkeysTitle: "Passkeys",
  passkeysNote: "Une passkey vous connecte avec votre empreinte, votre visage ou le code de l'appareil. Rien à retenir, rien à se faire voler.",
  noPasskeys: "Aucune passkey pour l'instant.",
  passkeyLabel: "Nom de cet appareil (ex. téléphone)",
  addPasskey: "Ajouter une passkey",
  remove: "Retirer",
  lastCredential: "Gardez au moins un moyen de vous connecter.",
  lastUsed: "utilisée {when}",
  neverUsed: "jamais utilisée",
  keysTitle: "Clés d'accès",
  keysNote: "Une clé agit en votre nom sur les apps qu'elle autorise, pour des scripts et des outils. Elle expire après 90 jours et n'ouvre jamais la console.",
  noKeys: "Aucune clé d'accès.",
  keyLabel: "À quoi elle sert",
  keyApps: "Valable pour",
  allMyApps: "toutes mes apps",
  createKey: "Créer une clé",
  keyShownOnce: "Copiez-la maintenant, elle ne sera plus affichée :",
  keyExpires: "expire {when}",
  signOut: "Se déconnecter",
  privacyNote: "Les administrateurs de ce serveur voient quelles apps vous ouvrez et quels jours. Rien de plus détaillé n'est conservé.",
  forbiddenTitle: "Accès refusé",
  forbiddenBody: "Vous êtes connecté en tant que {name}, mais il manque quelque chose à votre compte : {reason}.",
  backToAccount: "Votre compte",
  otherAccount: "Utiliser un autre compte",
};

export type Lang = "en" | "fr";
export type Key = keyof typeof en;
const tables: Record<Lang, typeof en> = { en, fr };

export function pickLang(acceptLanguage: string | undefined): Lang {
  return (acceptLanguage ?? "").trim().toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function translator(lang: Lang) {
  return (key: Key, vars?: Record<string, string | number>) => {
    let s: string = tables[lang][key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

export type T = ReturnType<typeof translator>;

// "il y a 3 jours" / "3 days ago", same approach as the dashboard
export function ago(lang: Lang, iso: string | Date) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return rtf.format(-Math.trunc(seconds / size), unit);
  }
  return rtf.format(0, "minute");
}
