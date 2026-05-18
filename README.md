# ESP32-CAM timelapse GitHub Pagesiin

Tama projekti tekee ESP32-CAM-moduulista tuntivalein kuvaavan timelapse-kameran:

- ESP32-CAM ottaa kuvan kerran tunnissa.
- Kuva tallennetaan microSD-kortille kansioon `/photos`.
- Jos Wi-Fi toimii, sama kuva lahetetaan GitHub-repon `photos/`-kansioon.
- GitHub Pages -sivu hakee `photos/`-kansion kuvat ja toistaa ne timelapsena selaimessa.

## Tiedostot

- `esp32_timelapse/esp32_timelapse.ino` - Arduino-sketch ESP32-CAMille.
- `esp32_timelapse/config.h.example` - asetuspohja Wi-Fille ja GitHubille.
- `docs/` - GitHub Pages -sivu.
- `photos/` - GitHubiin kertyvien kuvien kohdekansio.

## GitHub-repo

1. Luo GitHubiin julkinen repo, esimerkiksi `esp32-timelapse`.
2. Vie taman projektin tiedostot siihen repoon.
3. GitHubissa avaa repon asetukset: **Settings -> Pages**.
4. Valitse julkaisuhaaraksi `main` ja kansioksi `/docs`.
5. Muokkaa `docs/config.js`:

```js
window.TIMELAPSE_CONFIG = {
  owner: "oma-github-kayttajasi",
  repo: "esp32-timelapse",
  branch: "main",
  photoPath: "photos",
  frameRate: 8,
  refreshSeconds: 300
};
```

Sivu aukeaa osoitteessa `https://oma-github-kayttajasi.github.io/esp32-timelapse/`, kun Pages on julkaissut sen.

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

## Huomiot

- GitHub Pages on staattinen sivu, joten se ei voi vastaanottaa kuvien uploadia suoraan. Upload menee GitHub Contents API:n kautta.
- Sivu listaa kuvat Git Trees API:lla, jotta `photos/`-kansio voi kasvaa yli 1000 kuvan.
- Repo saa yhden commitin jokaista kuvaa kohden. Tunnin valilla se tarkoittaa noin 24 committia vuorokaudessa.
- Kuvat ovat julkisia, jos kaytat julkista repo + GitHub Pages -ratkaisua.
- Jos kuvia kertyy vuosiksi tai haluat isompia resoluutioita, erillinen kuvavarasto kuten S3, Cloudflare R2 tai Supabase Storage on pitkalla aikavalilla GitHubia parempi.
