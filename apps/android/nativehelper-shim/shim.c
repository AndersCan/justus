// Empty libnativehelper.so for ekrooh#45: libbare-kit.so DT_NEEDs it but never
// calls into it, so it only has to load. Rebuild with ./build.sh.
void AFileDescriptor_create(void) {}
void AFileDescriptor_getFd(void) {}
void AFileDescriptor_setFd(void) {}
void JNI_CreateJavaVM(void) {}
void JNI_GetDefaultJavaVMInitArgs(void) {}
void JNI_GetCreatedJavaVMs(void) {}
