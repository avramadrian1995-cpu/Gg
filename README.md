# MISEDA ITP

Platforma de programări și remindere ITP pentru **MISEDA INSPECT S.R.L.**, stație ITP autorizată RAR (SV096),
Str. Izvoarelor Nr. 2C, Rădăuți.

| Pagină | Adresă | Pentru cine |
|---|---|---|
| Site public cu programare online | `/` | Șoferi |
| Administrare stație | `/admin/` | Personalul stației |
| Portal flote | `/fleet/` | Firme cu mai multe vehicule |
| ITP Tracker | `/tracker/` | Șoferi (ITP, RCA, rovinietă, CASCO, date salvate în browser) |

## Ce face

**Site public**
- Programare în 3 pași: zi și oră (doar intervalele libere), datele mașinii, confirmare.
- SMS de confirmare și reminder cu o zi înainte. Link de anulare pentru client.
- Înscriere gratuită la reminder ITP (cu acord explicit, GDPR).
- Prețuri și program citite din setări. Date structurate schema.org (`AutoRepair`), titlu și descriere pentru „programare ITP Rădăuți”.

**Administrare stație**
- Programările pe zile, cu starea ITP-ului actual al fiecărei mașini.
- „Înregistrează ITP”: rezultat, valabilitate (sugerată după vechime și tip, editabilă), preț. Data expirării se salvează și reminderul următor pornește automat.
- Programări prin telefon, marcare „nu a venit”, anulare.
- Clienți și vehicule: căutare, filtru „expiră în 30/60 de zile”, editare, export CSV.
- Flote: creare firmă și cont de acces.
- Mesaje: toate SMS-urile / e-mailurile, cu status și reîncercare.
- Setări: date stație, program pe zile, zile libere, durata intervalului, linii de inspecție, servicii și prețuri, zilele de reminder, link recenzie Google.
- Statistici: programări, inspecții și încasări pe lună, ITP-uri care expiră.

**Portal flote**
- Toate vehiculele firmei cu data expirării ITP și status colorat.
- Programare pentru mai multe vehicule odată: fiecare primește primul interval liber din ziua aleasă.
- Istoric inspecții. Fiecare firmă vede doar vehiculele proprii.

**Remindere automate** (la fiecare 15 minute)
- ITP care expiră peste 30, 7 și 1 zile (configurabil), doar pentru clienții cu acord și fără programare deja făcută.
- Programările de mâine.
- Cerere de recenzie Google după ITP admis (opțional).
- Fiecare mesaj se trimite o singură dată. SMS-urile sunt fără diacritice și încap într-un singur SMS (160 caractere).

## Pornire

Necesită Node.js 22.9 sau mai nou. Baza de date este SQLite (inclusă în Node), fără server separat.

```sh
npm install
cp .env.example .env      # completați ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_URL
npm start                 # http://localhost:3000
```

Dacă nu setați `ADMIN_PASSWORD`, la prima pornire se creează un cont de administrator, iar parola apare în consolă.

Date de test (doar pe o bază goală):

```sh
DB_FILE=data/demo.db npm run seed:demo
DB_FILE=data/demo.db npm start
# admin@demo.ro / demo-parola-123   ·   flota@demo.ro / demo-parola-123
```

Teste: `npm test`.

### Docker

```sh
docker build -t miseda-itp .
docker run -d -p 3000:3000 -v miseda-data:/app/data \
  -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... -e PUBLIC_URL=https://... -e COOKIE_SECURE=1 -e TRUST_PROXY=1 miseda-itp
```

Rulați în spatele unui reverse proxy cu HTTPS (Caddy, nginx). Faceți backup la fișierul `data/miseda.db`.

## SMS și e-mail

Implicit (`NOTIFY_PROVIDER=log`) mesajele doar se afișează în consolă și apar în tabul Mesaje, ca să puteți testa fără costuri.
Pentru trimitere reală, setați `NOTIFY_PROVIDER=webhook` și `NOTIFY_WEBHOOK_URL`. Aplicația trimite pentru fiecare mesaj:

```json
POST NOTIFY_WEBHOOK_URL
Authorization: Bearer NOTIFY_WEBHOOK_TOKEN
{ "channel": "sms", "to": "0745123456", "subject": "...", "body": "..." }
```

Legați URL-ul la furnizorul de SMS ales (de ex. printr-un mic script sau un serviciu de automatizare).
Un răspuns non-2xx marchează mesajul ca eșuat și poate fi retrimis din admin.

## Înainte de lansare

- Setați prețurile reale în Administrare → Setări (cele implicite sunt exemple).
- Verificați valabilitățile ITP sugerate; inspectorul confirmă mereu data de pe certificat.
- Completați linkul de recenzie Google și linkul Google Maps.
- Actualizați telefonul pe directoarele ITP (itpinfo.ro afișează alt număr decât site-ul).
