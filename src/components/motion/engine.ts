import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";

gsap.registerPlugin(useGSAP, MotionPathPlugin, Flip);

export { gsap, useGSAP, Flip };
