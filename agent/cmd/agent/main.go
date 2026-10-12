package main

import (
	"fmt"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func main() {
	fmt.Println("mcsm-agent", (&mcsmv1.Hello{}).ProtoReflect().Descriptor().FullName())
}
