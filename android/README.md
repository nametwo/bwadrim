# 봐드림 안드로이드 앱 (OPS-08)

엔지니어용 앱이다. 웹(`https://bwadrim.com`)을 크롬이 주소창 없이 띄우는 앱(TWA)으로 감싼다. 앱 안에서 도는 것은 크롬이라, 화면을 고치면 웹 배포만으로 앱도 바뀐다. 앱을 다시 올리는 것은 이름·아이콘·패키지 설정이 바뀌거나 targetSdk를 올릴 때뿐이다.

이 폴더에 올리는 것은 `twa-manifest.json`(앱 설정)과 이 글뿐이다. 안드로이드 프로젝트는 Bubblewrap이 설정으로 만든다.

## 빌드 (GitHub Actions, 기본)

PC에 아무것도 깔지 않는다. `.github/workflows/android.yml`이 돌린다.

1. 처음 한 번, 업로드 키를 GitHub Secrets에 넣는다 (저장소 → Settings → Secrets and variables → Actions → New repository secret)
   - `ANDROID_KEYSTORE_BASE64`: 업로드 키 파일(`android.keystore`)을 base64로 적은 글 (`base64 -i android.keystore`)
   - `ANDROID_KEYSTORE_PASSWORD`: 그 키의 비밀번호
   - 키 파일과 비밀번호는 따로 안전한 곳에도 둔다. 저장소에는 올리지 않는다. 잃어버리면 플레이 콘솔에서 업로드 키 재설정을 요청해야 한다
2. 저장소 → **Actions** → **Android 앱 빌드** → **Run workflow**. 버전 이름은 비워 두면 `1.0.<실행 번호>`
3. 5분쯤 뒤 그 실행 페이지 아래 **Artifacts**에서 `bwadrim-android-<번호>`를 받는다. 안에 두 파일:
   - `app-release-bundle.aab`: 플레이 콘솔에 올리는 파일
   - `app-release-signed.apk`: 폰에 바로 깔아 보는 파일
4. versionCode는 실행 번호라 늘 올라간다. 플레이에 올릴 때마다 새로 돌리면 된다

## 빌드 (PC에서 직접, 예비)

1. Node 20 이상이 깔린 PC에서 `npm i -g @bubblewrap/cli`
2. 이 폴더에서 `bubblewrap doctor`를 돌린다. JDK 17과 안드로이드 SDK가 없으면 Bubblewrap이 받을지 묻는다
3. 업로드 키 `android.keystore`를 이 폴더에 둔다(새로 만들려면 아래 명령. 비밀번호는 키 저장소와 키 둘 다 같게)

   ```sh
   keytool -genkeypair -v -keystore android.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

4. 빌드

   ```sh
   cd android
   bubblewrap update --skipVersionUpgrade   # twa-manifest.json으로 안드로이드 프로젝트를 만든다
   bubblewrap build                          # 키 비밀번호를 묻는다
   ```

다시 올릴 때는 `--skipVersionUpgrade` 없이 `bubblewrap update`를 돌린다. 버전 번호(`appVersionCode`)가 하나 오르고 그 값이 `twa-manifest.json`에 적힌다. 이 파일을 커밋한다.

## 주소창 없애기 (앱 연결 파일)

`https://bwadrim.com/.well-known/assetlinks.json`에 앱 서명 키 지문이 없으면 앱 위에 주소창이 보인다.

1. 플레이 콘솔 → 앱 → 테스트 및 출시 → 설정 → 앱 서명에서 **앱 서명 키 인증서**의 SHA-256을 복사한다. 직접 깐 APK도 주소창 없이 보려면 업로드 키 인증서 것도 넣는다
2. 지문을 넣고 파일을 만든다

   ```sh
   bubblewrap fingerprint add <SHA-256> --name=play
   bubblewrap fingerprint generateAssetLinks --output=../public/.well-known/assetlinks.json
   ```

3. 커밋하고 배포한 뒤 브라우저에서 `https://bwadrim.com/.well-known/assetlinks.json`이 열리는지 본다(`www`나 다른 주소로 넘어가면 안 된다, OPS-07)

## 바꾸면 안 되는 것

- `packageId`(`com.bwadrim.app`)는 플레이에 처음 올린 뒤에는 바꿀 수 없다. 올리기 전에 확정한다
- `host`는 `bwadrim.com`. 예전 주소 `bwadrim-nametwo.vercel.app`은 앱에서 쓰지 않는다
