# APK-uri de test

| Fișier | Aplicație | Pachet | Server |
|---|---|---|---|
| `ITP-Miseda-test.apk` | ITP Miseda (test) | `ro.miseda.itp.test` | cere adresa la prima pornire; permite http în Wi-Fi-ul local |

Construit din `android/` cu `gradle assembleDebug` (semnat cu cheia de debug, nu pentru Google Play).

Instalare pe telefon prin USB:

```sh
adb devices                      # telefonul trebuie să apară ca "device"
adb install -r dist/ITP-Miseda-test.apk
adb shell monkey -p ro.miseda.itp.test 1   # pornește aplicația
```

Pe telefon: Setări → Despre telefon → apăsați de 7 ori pe „Numărul versiunii”, apoi
Setări → Sistem → Opțiuni pentru dezvoltatori → „Remedierea erorilor prin USB”.
