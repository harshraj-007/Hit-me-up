"use client";

import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { Flip } from "gsap/Flip";

// Registered once, here, so every module that imports from this file shares one
// registration instead of each caller registering plugins itself.
gsap.registerPlugin(useGSAP, Flip);

export { gsap, useGSAP, Flip };
