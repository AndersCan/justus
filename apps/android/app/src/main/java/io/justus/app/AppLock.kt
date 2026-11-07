package io.justus.app

import android.app.KeyguardManager
import android.content.Context
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

internal const val LOCK_AFTER_MS = 30_000L

/** Coming back from a picker, camera or our own prompt can take a while; past this it still locks. */
internal const val OWN_SCREEN_LOCK_AFTER_MS = 300_000L

private const val PREFS = "app_lock"
private const val KEY_ENABLED = "enabled"

/** stoppedAt: elapsedRealtime when the app last left the foreground; null = cold start. */
internal fun lockDue(enabled: Boolean, stoppedAt: Long?, now: Long, limitMs: Long = LOCK_AFTER_MS): Boolean =
    enabled && (stoppedAt == null || now < stoppedAt || now - stoppedAt >= limitMs)

internal sealed interface UnlockResult {
    data object Success : UnlockResult
    data object Cancelled : UnlockResult
    data class Failed(val message: String) : UnlockResult
}

internal fun isDeviceSecure(context: Context): Boolean =
    context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

internal fun readLockPref(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

internal fun writeLockPref(context: Context, enabled: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).apply()
}

/** The lock is on only while the phone still has a screen lock. */
internal fun lockEnabled(context: Context): Boolean = readLockPref(context) && isDeviceSecure(context)

private fun isCancel(code: Int): Boolean =
    code == BiometricPrompt.ERROR_USER_CANCELED ||
        code == BiometricPrompt.ERROR_CANCELED ||
        code == BiometricPrompt.ERROR_NEGATIVE_BUTTON

internal fun showUnlockPrompt(activity: FragmentActivity, onResult: (UnlockResult) -> Unit) {
    val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            onResult(UnlockResult.Success)
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            onResult(if (isCancel(errorCode)) UnlockResult.Cancelled else UnlockResult.Failed(errString.toString()))
        }
    }
    val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(activity.getString(R.string.lock_prompt_title))
        .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
        .build()
    BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
}
