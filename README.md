# ESP32-CAM timelapse GitHub Pagesiin

Tama projekti tekee ESP32-CAM-moduulista tuntivalein kuvaavan timelapse-kameran:

- ESP32-CAM ottaa kuvan kerran tunnissa.
- Kuva tallennetaan microSD-kortille kansioon `/photos`.
- Jos Wi-Fi toimii, sama kuva lahetetaan GitHub-repon `photos/`-kansioon.
- GitHub Pages -sivu hakee `photos/`-kansion kuvat, pikseloi ne selaimessa ja toistaa ne solar punk -savytettyna timelapsena.
- Kameraohjelma 2.0 jonottaa kuvat SD-kortille ja julkaisee tilatiedot.
- Sivulla on paivakalenteri, aikavalin rajaus ja MP4/GIF-vienti.

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
6. Kopioi asetuspohja:

```sh
cp esp32_timelapse/config.h.example esp32_timelapse/config.h
```

7. Tayta `config.h`: Wi-Fi, GitHub owner, repo, branch ja token.
8. Laita microSD-kortti moduuliin. FAT32 on varmin valinta.
9. Lataa sketch moduuliin Arduinon kautta.

Ensimmainen kuva otetaan heti kaynnistyksessa. Sen jalkeen moduuli menee deep sleep -tilaan ja heraa tunnin valein.

## Pikselityyli ja tiedostokoko

Oletuksena kamera tallentaa `FRAMESIZE_QVGA`-kuvan ja `JPEG_QUALITY 20` -pakkauksen. Tama pienentaa GitHubiin ladattavia tiedostoja merkittavasti verrattuna XGA/UXGA-kuviin. Jos haluat hieman enemman lahdetarkkuutta, vaihda `esp32_timelapse/config.h`-tiedostossa arvoksi `FRAMESIZE_VGA`.

Sivulla on kaksi katseluasetusta:

- `Resoluutio`: liukusaadin asteikolla 4 x 6 px -> tayden kuvan resoluutio.
- `Tyyli`: nelja palettia: minimalistinen, luontodokumentti, cinematic ja mustavalkoinen.

Oletuksia voi saataa `docs/config.js`-tiedostossa:

- `defaultResolution`: aloitusresoluutio. Arvot: `4x6`, `12`, `24`, `48`, `96`, `128`, `256`, `512`, `full`.
- `defaultStyle`: aloitustyyli. Arvot: `minimal`, `nature`, `cinematic`, `mono`.
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

Kirjastot on versiokiinnitetty ja toimitetaan `docs/vendor`-kansiossa lisensseineen. Tavallinen katselu ei lataa mediakirjastoja.

## Testaus

```sh
node --test tests/core.test.mjs
```

Selaintestit tarvitsevat Playwrightin, Chromiumin ja HTTP-palvelimen `docs`-kansiolle. Testit kayttavat repon kamerakuvia seka eristettyja tilatietovastauksia, eivatka kirjoita GitHubiin.

```sh
python3 -m http.server 8000 --directory docs
# Toisessa terminaalissa, kun playwright on asennettu:
node tests/browser.cjs
```

Muuttujat `TEST_BASE_URL`, `TEST_OUTPUT_DIR` ja `PLAYWRIGHT_MODULE` voivat vaihtaa palvelimen, tuloshakemiston ja Playwrightin moduulipolun. Testit tarkistavat paivamaarat, tilan, rajaukset, varityylit, pikseliresoluution, toiston, MP4:n ruutumaaran ja keston, GIF-viennin seka keskeytyksen tietokone- ja puhelinnakymissa.

Kameraohjelma on kaannostestattu Espressif-ytimella 3.3.12. Laitetestissa varmista viela SD-kortin jonon purku ja tilatiedoston julkaisu. Katkaise verkko yhdeksi kuvauskierrokseksi ja palauta se seuraavaksi: kortille jaaneen kuvan tulee saapua myohemmin ilman GitHub-kaksoiskappaleita. Ohjelma on ladattava moduuliin ennen kuin nama kameraominaisuudet ovat kaytossa.
