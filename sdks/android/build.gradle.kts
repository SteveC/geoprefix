plugins {
    id("com.android.library") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}
repositories { google(); mavenCentral() }
android {
    namespace = "net.goodspider.geoprefix"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
}
dependencies { implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0") }
