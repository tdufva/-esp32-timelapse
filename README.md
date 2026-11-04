# ESP32-CAM timelapse GitHub Pagesiin

Tama projekti tekee ESP32-CAM-moduulista ajastetun timelapse-kameran:

- ESP32-CAM kuvaa oletuksena paivalla 07-22 tunnin valein ja yolla kolmen tunnin valein.
- Kuva tallennetaan microSD-kortille kansioon `/photos`.
- Jos Wi-Fi toimii, sama kuva lahetetaan GitHub-repon `photos/`-kansioon.
- GitHub Pages -sivu hakee `photos/`-kansion kuvat, pikseloi ne selaimessa ja toistaa ne solar punk -savytettyna timelapsena.
- Kameraohjelma 2.0 jonottaa kuvat SD-kortille ja julkaisee tilatiedot.
- Sivulla on paivakalenteri, aikavalin rajaus ja MP4/GIF-vienti.
- Versio 3.0 lisaa suojatun HTTPS-huollon, OTA-paivitykset, pysyvan paiva/yoajastuksen ja yhtenaiset 8/16-varipaletit.

## Tiedostot

- `esp32_timelapse/esp32_timelapse.ino` - Arduino-sketch ESP32-CAMille.
- `esp32_timelapse/config.h.example` - asetuspohja Wi-Fille ja GitHubille.
- `docs/` - GitHub Pages -sivu.
- `photos/` - GitHubiin kertyvien kuvien kohdekansio.

## GitHub-repo

1. GitHub-repo on `tdufva/-esp32-timelapse`.
2. Vie taman projektin tiedostot siihen repoon.
3. GitHubissa avaa repon asetukset: **Settings -> Pages**.
4. Valitse julkaisuhaaraksi `main` ja kansioksi `/docs`.
5. Muokkaa `docs/config.js`:

```js
window.TIMELAPSE_CONFIG = {
  owner: "tdufva",
  repo: "-esp32-timelapse",
  branch: "main",
  photoPath: "photos",
  frameRate: 8,
  refreshSeconds: 300,
  pixelWidth: 128,
  defaultResolution: "128",
  defaultStyle: "minimal",
  defaultPalette: "16",
  solarBrightness: 1.18,
  solarSaturation: 1.35,
  solarLevels: 5
};
```

Sivu aukeaa osoitteessa `https://tdufva.github.io/-esp32-timelapse/`.

## GitHub-token ESP32:lle

ESP32 tarvitsee tokenin, jotta se voi luoda kuvatiedostoja repoosi. Tee GitHubissa fine-grained personal access token:

- Repository access: vain tama timelapse-repo.
- Permissions: **Contents: Read and write**.
- Expiration: valitse mieluummin rajattu aika ja uusi token tarvittaessa.

Token tallennetaan vain `esp32_timelapse/config.h`-tiedostoon. Ala committaa sita GitHubiin.

Sketch validoi GitHubin TLS-yhteyden mukana olevalla CA-varmenteella. Siksi GitHub-upload tehdaan vain, jos kellonaika saadaan synkattua NTP:lla. Jos GitHub vaihtaa varmenneketjua ja upload lakkaa toimimasta, paivita varmenne tai aseta `VERIFY_GITHUB_TLS 0` vain vianrajausta varten.

## Arduino-asetukset

1. Avaa Arduino IDE.
2. Lisaa Boards Manager -osoitteeksi:

```text
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

3. Asenna `esp32` by Espressif Systems.
   Asenna myos Library Managerista `ArduinoJson` (versio 7; testattu 7.4.3).
4. Valitse boardiksi yleensa **AI Thinker ESP32-CAM**.
5. Jos valikossa on PSRAM-asetus, laita PSRAM paalle.
   Valitse Partition Scheme: **Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS)** (`min_spiffs`). OTA ei toimi vanhalla `huge_app`-asettelulla.
6. Kopioi asetuspohja:

```sh
cp esp32_timelapse/config.h.example esp32_timelapse/config.h
```

7. Tayta `config.h`: Wi-Fi, GitHub owner, repo, branch ja token.
8. Laita microSD-kortti moduuliin. FAT32 on varmin valinta.
9. Luo huollon yksityiset tunnukset alla kuvatulla `init`-komennolla ja lataa sketch moduuliin Arduinon kautta. Ensimmainen OTA-version lataus on tehtava USB:lla, jotta myos osiotaulu vaihtuu. Ala kayta koko flashin tyhjennysta: NVS-asetukset ja SD-kortin kuvat sailyvat.

Kaynnistyksessa kuvataan heti, jos ajastus sallii kuvauksen. Sen jalkeen moduuli nukkuu seuraavaan ajastettuun kellonaikaan. Huoltopaivityksen jalkeinen uudelleenkaynnistys ei ota ylimaaraisia kuvia, ellei seuraava kuvausaika ole jo tullut.

## Pikselityyli ja tiedostokoko

Oletuksena kamera tallentaa `FRAMESIZE_QVGA`-kuvan ja `JPEG_QUALITY 20` -pakkauksen. Tama pienentaa GitHubiin ladattavia tiedostoja merkittavasti verrattuna XGA/UXGA-kuviin. Jos haluat hieman enemman lahdetarkkuutta, vaihda `esp32_timelapse/config.h`-tiedostossa arvoksi `FRAMESIZE_VGA`.

Sivun katseluasetukset:

- `Resoluutio`: liukusaadin asteikolla 4 x 6 px -> tayden kuvan resoluutio.
- `Tyyli`: nelja palettia: minimalistinen, luontodokumentti, cinematic ja mustavalkoinen.
- `Varipaletti`: vapaa, 8 tai 16 varia. Kiintea paletti pysyy samana kaikissa ruuduissa ja GIF-viennissa. Mustavalkoisessa kaytetaan harmaasavyja. MP4:n haviollinen pakkaus voi hieman muuttaa savyja.

Oletuksia voi saataa `docs/config.js`-tiedostossa:

- `defaultResolution`: aloitusresoluutio. Arvot: `4x6`, `12`, `24`, `48`, `96`, `128`, `256`, `512`, `full`.
- `defaultStyle`: aloitustyyli. Arvot: `minimal`, `nature`, `cinematic`, `mono`.
- `defaultPalette`: `original`, `8` tai `16` (oletus).
- `pixelWidth`: vanha yhteensopivuusasetus aloitusresoluutiolle, jos `defaultResolution` puuttuu.
- `solarBrightness`: kirkkauden kerroin.
- `solarSaturation`: varien voimakkuuden kerroin.
- `solarLevels`: varien posterointitasot. Pienempi arvo tekee graafisemman ja minimalistisemman kuvan.

## Huomiot

- GitHub Pages on staattinen sivu, joten se ei voi vastaanottaa kuvien uploadia suoraan. Upload menee GitHub Contents API:n kautta.
- Sivu listaa kuvat Git Trees API:lla, jotta `photos/`-kansio voi kasvaa yli 1000 kuvan.
- Repo saa yhden commitin jokaista kuvaa kohden. Tunnin valilla se tarkoittaa noin 24 committia vuorokaudessa.
- Kameraohjelma 2.0 tekee lisaksi yhden tilatietocommitin onnistunutta kuvauskierrosta kohden.
- Kuvat ovat julkisia, jos kaytat julkista repo + GitHub Pages -ratkaisua.
- Jos kuvia kertyy vuosiksi tai haluat isompia resoluutioita, erillinen kuvavarasto kuten S3, Cloudflare R2 tai Supabase Storage on pitkalla aikavalilla GitHubia parempi.

## Kameraohjelma 2.0: lahetysjono

- Alkuperaiset JPEG-kuvat sailyvat kortin `/photos`-kansiossa myos onnistuneen lahetyksen jalkeen.
- `/outbox` sisaltaa toimitusta odottavien kuvien kuittausmerkinnat. Merkinta luodaan ennen kuvan tallentamista, ja valmis kuva siirretaan `.part`-nimestaan lopulliseen nimeen.
- Ensimmainen 2.0-kaynnistys tuo myos vanhat kortilla olevat JPEG-kuvat jonoon. Jo GitHubissa olevan kuvan Git-blob-tiiviste tarkistetaan: vain identtinen kuva kuitataan toimitetuksi. Eri sisaltoista kuvaa ei korvata.
- Metatietovastauksen muistinkaytto on rajattu 64 kilotavuun. Tata suurempaa vastausta vaativa, jo olemassa oleva kuva jaa tarkistamatta jonoon; QVGA-kuvat mahtuvat normaalisti tahan rajaan.
- Uusin kuva lahetetaan ensin. Sen jalkeen puretaan vanhaa jonoa. Oletuksena enintaan 6 kuvaa kierroksessa ja 90 sekunnin tavoitebudjetti; yksittainen kesken oleva HTTPS-pyynto voi ylittaa tavoitebudjetin.
- Verkko-, oikeus- tai kirjoitusvirhe jattaa kuvan jonoon seuraavaa heratysta varten. Alkuperaista kuvaa ei poisteta.
- Keskeneraisen tallennuksen `.part`-tiedosto ja sita vastaava jonon merkinta siivotaan. Niita ei julkaista valmiina kuvina.
- Jos kortille tallentaminen epaonnistuu mutta verkkoyhteys toimii, ohjelma yrittaa edelleen lahettaa nykyisen kuvan suoraan.

Vanhojen kuvien tarkistus voi kestaa useita kuvauskierroksia. Ala poista `/outbox`-kansiota kesken jonon kasittelyn.

Lisavalinnat `config.h`:ssa ovat vapaaehtoisia. Vanha config.h toimii sellaisenaan:

```cpp
#define MAX_UPLOADS_PER_WAKE 6
#define UPLOAD_BUDGET_MS 90000UL
#define GITHUB_STATUS_PATH "status"
```

## Tilanakyma ja kalenteri

Kamera julkaisee `status/esp32cam.json`-tiedoston. Siina on viimeisin kuvaus ja onnistunut toimitus, seuraavan kuvan arvio, jonon pituus, kortin vapaa tila, viimeisella yhteydella mitattu Wi-Fi-signaali, ohjelmaversio ja virhekoodit. Tiedostossa ei julkaista Wi-Fi-nimea, salasanaa, IP-osoitetta tai GitHub-tokenia. Paikallinen kopio on kortilla `/camera-status.json`.

Tilanakyma on viimeisimman kuvauskierroksen tilannekuva, ei jatkuva verkkovalvonta. Kamera nukkuu kuvien valilla. Vanhentunut tilatieto ja viivastyneet kuvat erotetaan toisistaan. Vanha kameraohjelma voi edelleen lahettaa kuvia, vaikka tilatietoja ei viela olisi.

Kalenterissa nakyvat paivittaiset kuvamaarat. Pikavalinnat ovat kaikki kuvat, tama paiva, viimeiset seitseman paivaa ja tama kuukausi. Myos vapaa alku- ja loppupaiva on mahdollinen. Ajattomat `unsynced`-kuvat nakyvat vain Kaikki-valinnassa.

`docs/config.js` maarittaa kameran aikavyohykkeen (`timeZone`, oletuksena `Europe/Helsinki`) ja tilatiedoston polun (`cameraStatusPath`). Katselijan oman aikavyohykkeen vaihtuminen ei muuta kalenterin kuvauspaivia.

## Videovienti

`Vie video` koostaa valitun aikavalin kuvat valitulla pikselitarkkuudella ja varityylilla. Vienti tapahtuu kokonaan selaimessa: kuvia ei laheteta ulkopuoliseen muunnospalveluun. Kuvanopeus on 1-24 fps. Lopputulos skaalataan lahimman naapurin menetelmalla noin 640 pikselin pitkalle sivulle, jotta pikselit sailyvat teravina.

- MP4 kayttaa selaimen WebCodecs-enkooderia ja Mediabunny-kirjastoa. Jos selain ei tue sopivaa enkooderia, kaytettavissa on GIF-vienti.
- GIF kayttaa gifenc-kirjastoa. Enimmaismaara on 1000 ruutua; MP4:ssa 10000 ruutua.
- Vienti voidaan keskeyttaa. Kuvaus kamerassa jatkuu viennista riippumatta.
- Pienempi katseluresoluutio ei muuta SD-kortilla tai GitHubissa olevien alkuperaisten JPEG-tiedostojen kokoa.

Kirjastot on versiokiinnitetty ja toimitetaan `docs/vendor`-kansiossa lisensseineen. GIF:n varivalinta kayttaa gifenc-kirjastoa; MP4-kirjasto ladataan vasta vientia varten.

## HTTPS-huolto ja OTA

Huolto on suljettu normaalin kuvauksen aikana. Se avautuu kertakayttoisella GitHub-huoltopyynnolla seuraavalla verkkoyhteydellisella heratyksella enintaan 10 minuutiksi. Kameraa ei siis tarvitse pitaa jatkuvasti paalla. Uusi pyynto voidaan tehda paivittamatta ohjelmaa.

Tarvitset Node.js 22+:n, OpenSSL:n seka kaannokseen Arduino CLI:n, esp32-ytimen 3.3.12 ja ArduinoJson 7:n. Aja komennot projektin juuresta:

```sh
# Kerran ennen ensimmaista USB-latausta; ei tulosta salasanaa.
node tools/maintenance.mjs init
# Ohjelma kaannetaan yksityiseen valiaikaishakemistoon min_spiffs-asettelulla.
node tools/maintenance.mjs build --arduino-cli arduino-cli
# Julkaisee vain ei-salaisen, 24 tuntia voimassa olevan heratepyynnon.
node tools/maintenance.mjs request
```

Jos Arduino CLI tarvitsee erillisen asetustiedoston, anna `--arduino-config /polku/arduino-cli.yaml`. `build` tulostaa yksityisen `.bin`-tiedoston polun. Ala julkaise sita: ohjelma sisaltaa Wi-Fi-tiedot, GitHub-tokenin ja laitteen TLS-avaimen.

Huollon avauduttua avaa `https://esp32cam.local/` samassa lahiverkossa. Julkisella sivulla nakyy myos Avaa huolto -linkki voimassa olevan tilatiedon perusteella. Salasana ja varmenteen SHA-256-sormenjaljki ovat vain paikallisessa `.secrets/maintenance-login.txt`-tiedostossa. Selain varoittaa itse allekirjoitetusta laitevarmenteesta: vertaa sormenjalkea ennen poikkeuksen hyvaksynta. Ala asenna varmennetta yleiseksi luottamusjuureksi tai avaa huoltoporttia internetiin.

Huoltosivulla on viimeisin SD-kuva, ajastus, ohjelmapaikka, SHA-256-tarkistettu `.bin`-paivitys ja huollon paattaminen. Ohjelma kirjoitetaan passiiviseen ohjelmapaikkaan, ei kaynnissa olevan paalle. Sivusto vahvistaa paivityksen vasta uuden ohjelman kaynnistyksen jalkeen. Tama ei takaa automaattista palautumista, jos uusi ohjelma ei kaynnisty: silloin tarvitaan USB-palautus.

Myos komentorivi kayttaa vahvistettua ja laitteeseen sidottua TLS-varmennetta:

```sh
node tools/maintenance.mjs status
node tools/maintenance.mjs schedule --day-start 07:00 --night-start 22:00 --day-interval 60 --night-interval 180 --night-enabled true
node tools/maintenance.mjs upload --firmware /yksityinen/polku/esp32_timelapse.ino.bin
node tools/maintenance.mjs finish
```

Jos `.local`-nimipalvelu ei toimi, anna lisaksi `--address 192.168.x.x` laitteen oikealla lahiverkko-IP:lla. Varmenne tarkistetaan silti laitenimea vasten. Komennot eivat lisaa tunnuksia julkiselle sivulle tai URL-osoitteeseen. GitHub-token luetaan paikallisesta `config.h`:sta vain huoltopyynnon tekemiseen.

Pidata `.secrets/maintenance.json` turvallisessa varmuuskopiossa. `init` ei korvaa olemassa olevaa tunnusta tai varmennetta. Huollon salasana ja avain paketoidaan ohitettuun `maintenance_secrets.h`:hon. Jos tata tiedostoa ei ole, ohjelma kaantyy ilman huoltoa. Ala koskaan committaa naita salaisuuksia GitHubiin.

## Paiva/yoajastus

Oletus on paiva 07:00-22:00, 60 minuuttia; yo 180 minuuttia. Kellonaikaan sidotut oletushetket ovat paivalla 07, 08, ... 21 ja yolla 22, 01 ja 04. Aikavyohyke maaritetaan kameran `TIMEZONE`-asetuksella (Suomi). Kesaaikaan siirtyminen kasitellaan paikallisen ajan mukaan. Kaynnistymisen ja verkon viive voi siirtaa varsinaista kuvanottoa muutaman sekunnin.

Huoltosivun ajoitus tallentuu laitteen NVS-muistiin ja sailyy uudelleenkaynnistyksissa seka OTA-paivityksissa. Yon voi myos poistaa kaytosta. Kuvausvalit ovat 5-1440 minuuttia ja kumpikin jakso alkaa omasta alkukellonajastaan. Ilman verkkoyhteytta kaytetaan viimeksi saatua kelvollista kellonaikaa. Jos kelloa ei ole koskaan asetettu, varalla on vanha 60 minuutin kuvausvali; GitHub-lahetys odottaa NTP-synkronointia.

## Testaus

```sh
node --test tests/*.test.mjs
c++ -std=c++17 tests/schedule_test.cpp -o /tmp/esp32-schedule-test
/tmp/esp32-schedule-test
node tools/embed-maintenance.mjs --check
```

Selaintestit tarvitsevat Playwrightin, Chromiumin ja HTTP-palvelimen `docs`-kansiolle. Testit kayttavat repon kamerakuvia seka eristettyja tilatietovastauksia, eivatka kirjoita GitHubiin.

```sh
python3 -m http.server 8000 --directory docs
# Toisessa terminaalissa, kun playwright on asennettu:
node tests/browser.cjs
# Huoltosivun eristetty HTTPS-selaintesti init-komennon jalkeen:
node tests/maintenance-browser.mjs
```

Muuttujat `TEST_BASE_URL`, `TEST_OUTPUT_DIR` ja `PLAYWRIGHT_MODULE` voivat vaihtaa palvelimen, tuloshakemiston ja Playwrightin moduulipolun. Testit tarkistavat paivamaarat, tilan, rajaukset, varityylit, pikseliresoluution, toiston, MP4:n ruutumaaran ja keston, GIF-viennin seka keskeytyksen tietokone- ja puhelinnakymissa.

Kameraohjelma on kaannostestattu Espressif-ytimella 3.3.12. Laitetestissa varmista viela SD-kortin jonon purku ja tilatiedoston julkaisu. Katkaise verkko yhdeksi kuvauskierrokseksi ja palauta se seuraavaksi: kortille jaaneen kuvan tulee saapua myohemmin ilman GitHub-kaksoiskappaleita. Ohjelma on ladattava moduuliin ennen kuin nama kameraominaisuudet ovat kaytossa.
