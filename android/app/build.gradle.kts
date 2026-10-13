import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing: android/keystore.properties (not in git) points at the keystore.
// The same key must sign every release, otherwise Android refuses to update the app.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Version comes from the desktop app so both platforms release together.
val appVersion: String = groovy.json.JsonSlurper()
    .parse(rootProject.file("../src-tauri/tauri.conf.json"))
    .let { (it as Map<*, *>)["version"] as String }

android {
    namespace = "com.aurora.vpn"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.aurora.vpn"
        minSdk = 26
        targetSdk = 36
        versionName = appVersion
        versionCode = appVersion.split(".").let { (a, b, c) -> a.toInt() * 10000 + b.toInt() * 100 + c.toInt() }
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    // The sing-box CLI ships as libsingbox.so and is executed from nativeLibraryDir,
    // so native libraries must be extracted on install.
    packaging { jniLibs { useLegacyPackaging = true } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(files("libs/libv2ray.aar"))
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.17.1")
}
