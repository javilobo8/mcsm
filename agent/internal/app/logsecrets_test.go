package app

import (
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestLogSecretsComeFromTheStoredSpec(t *testing.T) {
	a, _, st := newApp(t)
	js := `{"imageTag":"java21","type":"AUTO_CURSEFORGE","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","curseforgeApiKey":"$2a$10$clave"}`
	if err := st.PutSpec(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, SpecJson: []byte(js)}); err != nil {
		t.Fatal(err)
	}
	got := a.logSecrets("a")
	if len(got) != 2 || got[0] != "abcdefgh" || got[1] != "$2a$10$clave" {
		t.Fatalf("secrets = %v", got)
	}
	if a.logSecrets("unknown") != nil {
		t.Fatal("without a spec there are no secrets")
	}
}
