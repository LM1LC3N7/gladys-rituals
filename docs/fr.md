# Rituals Perfume Genie

Amène dans Gladys les diffuseurs **Rituals Perfume Genie 2.0** de votre compte
Rituals, par le cloud Rituals (celui de l’application Rituals). Intégration
non officielle, sans lien avec Rituals.

> Cette intégration n’a jamais été testée avec un vrai diffuseur : elle est
> écrite d’après la bibliothèque `ritualsgenie` (celle de Home Assistant) et
> testée contre un cloud Rituals simulé. Vos retours sont bienvenus sur le
> forum.

## Ce que vous obtenez

Un appareil Gladys par diffuseur du compte, nommé comme dans l’application
Rituals :

| Fonctionnalité            | Type                       | Remarques                                                           |
| ------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Diffusion                 | interrupteur, marche/arrêt | Commande : allumer, éteindre.                                       |
| Intensité du parfum (1-3) | vitesse, 1 à 3             | Commande : 1 faible, 2 moyenne, 3 forte.                            |
| Niveau de parfum          | niveau, %                  | Estimation d’après l’usage de la cartouche, comme dans l’appli.     |
| Parfum                    | texte                      | Le nom du parfum, ou « Aucune cartouche ».                          |
| Signal Wi-Fi              | signal, 0 à 5              | D’après le RSSI que remonte le diffuseur.                           |
| Batterie, En charge       | batterie %, en charge      | Genie portable seulement ; niveau approximatif (icônes de l’appli). |

Un diffuseur que Rituals indique hors ligne reçoit un badge « injoignable » et
aucune nouvelle valeur jusqu’à son retour.

## Configuration

1. Dans l’onglet **Configuration**, saisissez l’**e-mail** et le **mot de
   passe** de votre compte Rituals. Le mot de passe est gardé par Gladys dans
   sa base, jamais réaffiché, et envoyé seulement à Rituals. Un mot de passe
   sans e-mail n’est pas utilisé.
2. L’**intervalle de rafraîchissement** (5 minutes par défaut, de 2 minutes à
   1 heure) règle la lecture de la liste des diffuseurs : une requête à chaque
   fois, quel que soit le nombre de diffuseurs. Les capteurs (niveau, parfum,
   Wi-Fi, batterie) coûtent une requête chacun : ils sont lus pour un
   diffuseur par lecture, au plus toutes les 30 minutes. Rituals a déjà bloqué
   des clients trop insistants.
3. Enregistrez, puis ajoutez les diffuseurs depuis l’onglet **Découverte**.
4. **Tester la connexion** affiche les diffuseurs trouvés. Le compte n’est lu
   que si l’intervalle est écoulé depuis la dernière lecture ; sinon le bouton
   affiche la dernière lecture et l’heure de la prochaine.

## Comment l’intégration parle à Rituals

- Elle se connecte avec l’e-mail et le mot de passe et garde le jeton que
  donne Rituals (valable environ une heure) en mémoire seulement. Elle le
  renouvelle une minute avant son expiration, comparée à la date qu’envoie
  Rituals ; sans cette date, le jeton sert jusqu’à ce que Rituals le refuse.
  Les connexions pour les lectures et pour les commandes d’allumage ou
  d’intensité sont espacées d’au moins 2 minutes (une extinction se connecte
  aussitôt). Un 401 sur une commande d’un diffuseur, avec un jeton que la
  liste du compte accepte, refuse cette commande et garde le jeton. Un 400 ou
  422 de la connexion sans message sur les identifiants est une réponse
  inattendue, réessayée plus tard, pas un mot de passe refusé. Une extinction
  refusée par un 401 se reconnecte une fois pour ce jeton et repart ; pour
  l’allumage et l’intensité, un jeton révoqué est renouvelé à la lecture
  suivante.
- Elle se présente sous son propre nom (`gladys-rituals`), pas comme
  l’application Rituals, et n’envoie aucune clé de l’application.
- **Mot de passe refusé** : quand Rituals refuse l’e-mail ou le mot de passe,
  plus rien n’est tenté tant que vous ne les changez pas ou que le bouton
  **Tester la connexion** ne réussit pas (une connexion par clic, 30 secondes
  d’écart après un refus). Le refus est retenu après un redémarrage par un
  marqueur qui ne permet pas de retrouver le mot de passe.
- **Trop d’essais de connexion** : Rituals bloque alors les connexions un
  moment (il dit combien de temps) ; aucune connexion n’est tentée avant la
  fin, même après un redémarrage.
- **429** (trop de requêtes) ou **5xx** sur une lecture : lectures et
  commandes font une pause aussi longue que Rituals le demande (Retry-After),
  sinon 1 minute, doublée à chaque fois, 6 heures au plus ; la pause survit à
  un redémarrage. Une extinction n’est pas mise en pause. Un 5xx sur une
  commande ne concerne que ce diffuseur (pas de pause).
- **Erreurs réseau, réponses illisibles** : les lectures attendent un peu plus
  à chaque fois (jamais moins que l’intervalle). Un 401 sur un jeton que Rituals vient de
  donner n’est pas un mot de passe refusé : les lectures sont espacées,
  doublées à chaque fois, jusqu’à une heure.
- Après un redémarrage, la lecture suivante ne vient pas avant l’intervalle
  écoulé depuis la précédente, même si l’horloge de la machine a bougé.

## Commandes

- **Allumer** et **intensité** attendent leur tour par diffuseur (deux au plus
  en attente) et sont refusées, sans rien envoyer, pendant que Rituals demande
  d’attendre (429), pour un diffuseur hors ligne ou inconnu, ou avec un mot de
  passe refusé. Une fois envoyée, l’intégration relit le diffuseur : l’état
  dans Gladys ne change que si Rituals montre la valeur demandée. Sinon
  (« pas encore appliquée », ou pas de réponse), Gladys garde l’état précédent
  et la liste est relue 5 et 20 secondes plus tard.
- **Éteindre** est traité comme une commande de protection. Elle n’attend ni
  une lecture en cours (une lecture muette depuis une seconde est coupée, sans
  compter comme un échec), ni la pause 429, ni l’espacement des connexions, ni
  les autres commandes ; elle se connecte aussitôt si aucun jeton n’est
  détenu ; elle annule les commandes d’allumage et d’intensité encore en
  attente pour ce diffuseur ; si une commande était déjà partie, l’extinction
  est renvoyée après elle. Elle est gardée dans `/data` et réessayée chaque
  minute pendant 30 minutes, jusqu’à ce qu’une lecture faite après elle montre
  le diffuseur éteint, sauf si une commande plus récente pour ce diffuseur est
  partie entre-temps. Seuls les envois arrivés chez Rituals comptent, trois au
  plus : un essai jamais parti (réseau coupé, connexions bloquées, 429, 401
  avant le renouvellement du jeton) ne compte pas, et l’extinction part dès
  qu’elle le peut ; après un 429, pas avant le Retry-After de Rituals (dans
  les 30 minutes). Une deuxième extinction d’un diffuseur dont l’extinction
  est en route la rejoint. Une extinction partie sans réponse est relue 5 et
  20 secondes plus tard (ce seul diffuseur, même pendant une pause) ; un diffuseur rallumé
  depuis l’application Rituals avant cette confirmation peut être réteint par
  un renvoi. Après un redémarrage, une extinction gardée part dès que la
  configuration est lue, avant la première lecture ; une extinction cliquée
  avant que Gladys ait donné la configuration est gardée et part à ce
  moment.

  Une extinction n’est refusée que si : aucun compte n’est configuré une fois
  la configuration lue (ou
  l’e-mail manque ou n’est pas valide) ; Rituals a refusé l’e-mail ou le mot de
  passe (jusqu’à leur changement ou un succès du bouton de test) ; Rituals
  bloque les connexions et aucun jeton n’est détenu (elle est alors gardée et
  renvoyée) ; le diffuseur n’a jamais été vu sur le compte (ni dans une
  lecture, ni dans `/data`) ; Rituals répond que le diffuseur n’est pas lié au
  compte ; Rituals répond à l’extinction par une autre erreur 4xx (elle est
  alors gardée et renvoyée).

Les programmes du diffuseur (réglés dans l’application Rituals) continuent de
fonctionner et peuvent l’allumer ou l’éteindre d’eux-mêmes.

## Vie privée et données

`/data/rituals-state.json` garde : l’heure de la dernière lecture et de la
dernière connexion, une pause ou un blocage demandé par Rituals, le marqueur
d’un refus de connexion (8 bits d’une empreinte salée), une empreinte salée du
compte, les diffuseurs vus (hublot, hash de l’API) et les extinctions
encore à confirmer. Ni le mot de passe, ni l’e-mail, ni le jeton. Si le
fichier est illisible, il n’est pas écrasé.

## Dépannage

- **« Rituals a refusé l’e-mail ou le mot de passe »** : vérifiez-les dans
  l’application Rituals, corrigez-les dans Gladys (l’intégration réessaie
  aussitôt) ou cliquez sur **Tester la connexion**.
- **« pause »** : Rituals a demandé d’attendre ; l’intégration reprend seule.
- **Un diffuseur manque** : il doit être sur le compte et avoir un
  identifiant valide ; les journaux (`docker logs`) signalent ceux qui sont
  écartés.
