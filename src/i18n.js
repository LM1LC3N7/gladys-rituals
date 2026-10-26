// -----------------------------------------------------------------------------
// The texts shown in Gladys: feature names, connection statuses, command
// errors, the test button. Statuses are `{ en, fr }` objects (Gladys picks
// the language of the user); feature names follow the `language` option.
// -----------------------------------------------------------------------------

/** "45 s", "12 min", "2 h 05". */
export function age(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

export const FEATURE_NAMES = {
  power: { en: 'Diffusing', fr: 'Diffusion' },
  intensity: { en: 'Perfume intensity (1-3)', fr: 'Intensité du parfum (1-3)' },
  fill: { en: 'Perfume level', fr: 'Niveau de parfum' },
  perfume: { en: 'Perfume', fr: 'Parfum' },
  wifi: { en: 'Wi-Fi signal', fr: 'Signal Wi-Fi' },
  battery: { en: 'Battery', fr: 'Batterie' },
  charging: { en: 'Charging', fr: 'En charge' },
};

export const NO_CARTRIDGE = { en: 'No cartridge', fr: 'Aucune cartouche' };

/** The reason of a RitualsError, as a short text. */
export const REASONS = {
  network: { en: 'network error', fr: 'erreur réseau' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  size: { en: 'answer too large', fr: 'réponse trop grande' },
  aborted: { en: 'request cut', fr: 'requête coupée' },
  unauthorized: {
    en: 'token refused by Rituals',
    fr: 'jeton refusé par Rituals',
  },
  not_linked: {
    en: 'diffuser not linked to this account',
    fr: 'diffuseur non lié à ce compte',
  },
  rate_limited: { en: 'Rituals asks to wait', fr: 'Rituals demande d’attendre' },
  server: { en: 'Rituals server error', fr: 'erreur du serveur Rituals' },
  http: { en: 'unexpected answer', fr: 'réponse inattendue' },
  bad_response: { en: 'unreadable answer', fr: 'réponse illisible' },
  bad_request: { en: 'invalid request', fr: 'requête invalide' },
  refused: { en: 'e-mail or password refused', fr: 'e-mail ou mot de passe refusé' },
  locked: { en: 'logins locked by Rituals', fr: 'connexions bloquées par Rituals' },
  login_wait: { en: 'login spaced out', fr: 'connexion espacée' },
  no_credentials: { en: 'no account configured', fr: 'aucun compte configuré' },
};

export const reasonOf = (code) => REASONS[code] ?? REASONS.http;

const both = (fn) => ({ en: fn('en'), fr: fn('fr') });

export const T = {
  problems: {
    missing_credentials: {
      en: 'Enter the e-mail and the password of your Rituals account.',
      fr: 'Saisissez l’e-mail et le mot de passe de votre compte Rituals.',
    },
    missing_email: {
      en: 'The e-mail of the Rituals account is missing: the password is not used without it.',
      fr: 'L’e-mail du compte Rituals manque : le mot de passe n’est pas utilisé sans lui.',
    },
    missing_password: {
      en: 'The password of the Rituals account is missing.',
      fr: 'Le mot de passe du compte Rituals manque.',
    },
    invalid_email: {
      en: 'The e-mail is not valid (one @, no space nor line break).',
      fr: 'L’e-mail n’est pas valide (un @, ni espace ni saut de ligne).',
    },
    invalid_password: {
      en: 'The password contains a line break or a control character.',
      fr: 'Le mot de passe contient un saut de ligne ou un caractère de contrôle.',
    },
  },
  connecting: { en: 'Connecting to Rituals…', fr: 'Connexion à Rituals…' },
  configUnread: {
    en: 'The configuration could not be read from Gladys: trying again.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai.',
  },
  connected: (count, online) =>
    both((l) =>
      l === 'fr'
        ? `Connecté : ${count} diffuseur${count > 1 ? 's' : ''}, ${online} en ligne.`
        : `Connected: ${count} diffuser${count === 1 ? '' : 's'}, ${online} online.`,
    ),
  refused: {
    en: 'Rituals refused the e-mail or the password. Nothing is tried again until they change or the "Test the connection" button succeeds.',
    fr: 'Rituals a refusé l’e-mail ou le mot de passe. Plus aucun essai tant qu’ils ne changent pas ou que le bouton « Tester la connexion » ne réussit pas.',
  },
  locked: (wait) =>
    both((l) =>
      l === 'fr'
        ? `Rituals bloque les connexions (trop d’essais) : nouvel essai dans ${wait}.`
        : `Rituals locked the logins (too many attempts): next try in ${wait}.`,
    ),
  paused: (code, wait) =>
    both((l) =>
      l === 'fr'
        ? `${reasonOf(code).fr} : pause, nouvel essai dans ${wait}.`
        : `${reasonOf(code).en}: paused, next try in ${wait}.`,
    ),
  retry: (code, wait) =>
    both((l) =>
      l === 'fr'
        ? `Rituals injoignable (${reasonOf(code).fr}) : nouvel essai dans ${wait}.`
        : `Rituals unreachable (${reasonOf(code).en}): next try in ${wait}.`,
    ),
  offline: {
    en: 'Offline in the Rituals cloud',
    fr: 'Hors ligne dans le cloud Rituals',
  },
  command: {
    unknown: {
      en: 'Unknown diffuser: nothing sent (wait for the next read of the account).',
      fr: 'Diffuseur inconnu : rien envoyé (attendez la prochaine lecture du compte).',
    },
    invalid: {
      en: 'Invalid value: nothing sent.',
      fr: 'Valeur invalide : rien envoyé.',
    },
    offline: {
      en: 'The diffuser is offline in the Rituals cloud: nothing sent.',
      fr: 'Le diffuseur est hors ligne dans le cloud Rituals : rien envoyé.',
    },
    queueFull: {
      en: 'Too many commands waiting for this diffuser: nothing sent.',
      fr: 'Trop de commandes en attente pour ce diffuseur : rien envoyé.',
    },
    cancelled: {
      en: 'Cancelled by a turn off sent meanwhile: nothing sent.',
      fr: 'Annulée par une extinction envoyée entre-temps : rien envoyé.',
    },
    nothingSent: (code) =>
      both((l) =>
        l === 'fr' ? `Rien envoyé : ${reasonOf(code).fr}.` : `Nothing sent: ${reasonOf(code).en}.`,
      ),
    rejected: (code) =>
      both((l) =>
        l === 'fr'
          ? `Refusée par Rituals : ${reasonOf(code).fr}.`
          : `Refused by Rituals: ${reasonOf(code).en}.`,
      ),
    offWaitConfig: {
      en: 'Turn off kept: it leaves as soon as the configuration is read from Gladys.',
      fr: 'Extinction gardée : elle partira dès la lecture de la configuration depuis Gladys.',
    },
    offKept: (code) =>
      both((l) =>
        l === 'fr'
          ? `Extinction pas encore partie (${reasonOf(code).fr}) : gardée, renvoyée dans la minute.`
          : `Turn off not sent yet (${reasonOf(code).en}): kept, sent again within a minute.`,
      ),
  },
  test: {
    ok: (count, online, names) =>
      both((l) =>
        l === 'fr'
          ? `Connexion réussie : ${count} diffuseur${count > 1 ? 's' : ''}, ${online} en ligne.${names}`
          : `Connection succeeded: ${count} diffuser${count === 1 ? '' : 's'}, ${online} online.${names}`,
      ),
    wait: (wait) =>
      both((l) =>
        l === 'fr'
          ? `Une connexion vient d’être refusée : réessayez dans ${wait}.`
          : `A login was just refused: try again in ${wait}.`,
      ),
    recent: (wait) =>
      both((l) =>
        l === 'fr'
          ? ` Dernière lecture conservée : la suivante dans ${wait} (jamais plus souvent que l’intervalle).`
          : ` Last read kept: the next one in ${wait} (never more often than the interval).`,
      ),
  },
};
