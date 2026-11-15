const Constants = {
	InjectorKeys: {
		// The app's AuthProvidersService (sign-in, linking, and renewing a sign-in for
		// ServerTokenAuthService).
		SERVICE_AUTH_PROVIDERS: 'serviceAuthProviders',
		// @thzero/library_client_firebase's FirebaseProofService, for Google sign-in.
		SERVICE_AUTH_FIREBASE_PROOF: 'serviceAuthFirebaseProof'
	}
};

export default Constants;
