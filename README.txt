ICC RECORD SCANNER — FLUTTER VERSION

Fastest method:
1. Extract this ZIP to a normal folder, for example Desktop\ICCRecordScanner_Flutter.
2. Double-click BUILD_APK.bat.
3. The first build needs internet access.
4. The finished APK will be copied to:
   output\ICCRecordScanner.apk

Manual CLI method:
  flutter create --platforms=android --org com.dhom .
  flutter pub get
  flutter build apk --release

Original Flutter output:
  build\app\outputs\flutter-apk\app-release.apk

Important:
- Flutter must be available in Windows PATH.
- Android SDK must be accepted/configured. Check using: flutter doctor
- The app uses the camera, local SQLite storage, Android share sheet, and XLSX export.


This package already includes the custom Amtel app icon in assets/icon/app_icon.png.

Version 1.1 groups records by day and minute and shows record timestamps.
