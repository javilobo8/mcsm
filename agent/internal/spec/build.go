package spec

import (
	"fmt"
	"regexp"
	"strings"
)

// Campo build (plan 10): build del servidor o versión del loader. Vacío = el último (lo elige
// itzg): no se emite nada y el hash no cambia. Espejo de panel/packages/shared/src/versions.ts;
// casos compartidos en proto/fixtures/build-cases.json.

// buildEnvKeys es la variable de itzg que genera build según el tipo. Folia usa FOLIABUILD (sin
// guion bajo; scripts/start-deployFolia de itzg).
var buildEnvKeys = map[string]string{
	"PAPER": "PAPER_BUILD", "FOLIA": "FOLIABUILD", "PURPUR": "PURPUR_BUILD",
	"FABRIC": "FABRIC_LOADER_VERSION", "QUILT": "QUILT_LOADER_VERSION",
	"FORGE": "FORGE_VERSION", "NEOFORGE": "NEOFORGE_VERSION",
}

// Misma regex que BUILD_RE en el panel.
var buildRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

func isFloatingVersion(v string) bool {
	return strings.EqualFold(v, "LATEST") || strings.EqualFold(v, "SNAPSHOT")
}

func (s Spec) validateBuild() error {
	if s.Build == "" {
		return nil
	}
	if !buildRe.MatchString(s.Build) {
		return fmt.Errorf("spec: build inválido (letras, números y . _ + -; máx. 64; empieza por letra o número)")
	}
	key, ok := buildEnvKeys[s.Type]
	if !ok {
		return fmt.Errorf("spec: el tipo %s no admite fijar el build (solo Paper, Folia, Purpur, Fabric, Quilt, Forge y NeoForge)", s.Type)
	}
	if isFloatingVersion(s.Version) {
		return fmt.Errorf("spec: para fijar el build elige una versión concreta de Minecraft (no LATEST ni SNAPSHOT)")
	}
	// El env libre gana sobre lo generado: anularía el build en silencio.
	if _, ok := s.Env[key]; ok {
		return fmt.Errorf("spec: Quita la variable %s de las variables de entorno (Avanzado): la fija el campo Build", key)
	}
	return nil
}

// buildEnvVars añade al entorno generado la variable del build, si lo hay.
func (s Spec) buildEnvVars(m map[string]string) {
	if s.Build == "" {
		return
	}
	if key, ok := buildEnvKeys[s.Type]; ok {
		m[key] = s.Build
	}
}
