package spec

import (
	"fmt"
	"regexp"
	"strings"
)

// Build field (plan 10): the server build or loader version. Empty = the latest (chosen by
// itzg): nothing is emitted and the hash does not change. Mirror of panel/packages/shared/src/versions.ts;
// shared cases in proto/fixtures/build-cases.json.

// buildEnvKeys is the itzg variable that build generates depending on the type. Folia uses FOLIABUILD (no
// underscore; itzg's scripts/start-deployFolia).
var buildEnvKeys = map[string]string{
	"PAPER": "PAPER_BUILD", "FOLIA": "FOLIABUILD", "PURPUR": "PURPUR_BUILD",
	"FABRIC": "FABRIC_LOADER_VERSION", "QUILT": "QUILT_LOADER_VERSION",
	"FORGE": "FORGE_VERSION", "NEOFORGE": "NEOFORGE_VERSION",
}

// Same regex as BUILD_RE in the panel.
var buildRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

func isFloatingVersion(v string) bool {
	return strings.EqualFold(v, "LATEST") || strings.EqualFold(v, "SNAPSHOT")
}

func (s Spec) validateBuild() error {
	if s.Build == "" {
		return nil
	}
	if !buildRe.MatchString(s.Build) {
		return fmt.Errorf("spec: invalid build (letters, digits and . _ + -; max. 64; starts with a letter or digit)")
	}
	key, ok := buildEnvKeys[s.Type]
	if !ok {
		return fmt.Errorf("spec: type %s does not support setting the build (only Paper, Folia, Purpur, Fabric, Quilt, Forge and NeoForge)", s.Type)
	}
	if isFloatingVersion(s.Version) {
		return fmt.Errorf("spec: to set the build choose a specific Minecraft version (not LATEST or SNAPSHOT)")
	}
	// Free-form env wins over what is generated: it would silently override the build.
	if _, ok := s.Env[key]; ok {
		return fmt.Errorf("spec: Remove the %s variable from the environment variables (Advanced): it is set by the Build field", key)
	}
	return nil
}

// buildEnvVars adds the build variable to the generated environment, if there is one.
func (s Spec) buildEnvVars(m map[string]string) {
	if s.Build == "" {
		return
	}
	if key, ok := buildEnvKeys[s.Type]; ok {
		m[key] = s.Build
	}
}
