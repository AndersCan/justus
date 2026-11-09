# R8 keep rules for release builds. Everything not named here may be shrunk.
#
# The bare-host AAR also ships consumer rules (proguard.txt) that keep all of
# to.holepunch.bare.android.** and to.holepunch.bare.kit.**. The rules below
# are this app's own, narrow statement of what native code reaches, so the
# build stays correct if the AAR ever narrows its rules.
#
# Source of the names: libbare-kit.so (bare-host 0.6.2) exports
#   Java_to_holepunch_bare_kit_IPC_{init,destroy,read,write,update}
#   Java_to_holepunch_bare_kit_Worklet_{init,start,suspend,resume,terminate,push}
# and calls back into Worklet$NativePushCallback.apply(ByteBuffer, String)
# (descriptor "(Ljava/nio/ByteBuffer;Ljava/lang/String;)V" in the .so) and the
# IPC poll/read/write callbacks. Classes read from classes.jar of the AAR.

# (a) JNI: native methods keep their names (the Java_... symbols bind by name).
-keepclasseswithmembernames,includedescriptorclasses class to.holepunch.bare.kit.** {
    native <methods>;
}

# (a) JNI: native-owned handle and worklet fields.
-keepclassmembers class to.holepunch.bare.kit.IPC {
    java.nio.ByteBuffer handle;
    to.holepunch.bare.kit.Worklet worklet;
}
-keepclassmembers class to.holepunch.bare.kit.Worklet {
    java.nio.ByteBuffer handle;
}

# (a) JNI: callbacks native code invokes by name.
-keep interface to.holepunch.bare.kit.Worklet$NativePushCallback { *; }
-keep interface to.holepunch.bare.kit.IPC$PollCallback { *; }
-keep interface to.holepunch.bare.kit.IPC$ReadCallback { *; }
-keep interface to.holepunch.bare.kit.IPC$WriteCallback { *; }

# (a) Worklet.Options is read field by field when a worklet starts.
-keepclassmembers class to.holepunch.bare.kit.Worklet$Options {
    int memoryLimit;
    java.lang.String assets;
}

# (b) No @JavascriptInterface methods: the WebView talks to the worklet over
#     HTTP and a document-start script, not addJavascriptInterface.
# (c) Manifest: MainActivity and androidx FileProvider are kept by AAPT2's
#     generated rules. The app does no Class.forName or reflection.
