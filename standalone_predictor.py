#!/usr/bin/env python3
"""
Standalone version of your Stable Diffusion predictor
Run this directly without Cog
"""

import sys
import os
import argparse
from typing import Optional, List
import json
import traceback
import cv2
import av
import numpy as np
import torch
from torch import autocast
from diffusers import StableDiffusionPipeline, StableDiffusionImg2ImgPipeline
from PIL import Image

MODEL_CACHE = "diffusers-cache"

def patch_conv(**patch):
    cls = torch.nn.Conv2d
    init = cls.__init__

    def __init__(self, *args, **kwargs):
        for k, v in patch.items():
            kwargs[k] = v
        return init(self, *args, **kwargs)

    cls.__init__ = __init__

patch_conv(padding_mode="circular")

class StableDiffusionPredictor:
    def __init__(self):
        self.pipe = None
        self.use_img2img = False

    def setup(self, use_img2img=False):
        """Load the model into memory"""
        print("Loading Stable Diffusion pipeline...")
        self.use_img2img = use_img2img

        if use_img2img:
            self.pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
                "models/stable-diffusion-v1-5",
                torch_dtype=torch.float16,
                feature_extractor=None,
                safety_checker=None
            )
        else:
            self.pipe = StableDiffusionPipeline.from_pretrained(
                "models/stable-diffusion-v1-5",
                torch_dtype=torch.float16,
                feature_extractor=None,
                safety_checker=None
            )

        try:
            self.pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            print("XFormers not available, using standard attention")

    def generate_texture(self, prompt: str, image_path: str = None, output_path: str = "output.png"):
        """Generate a single texture image"""
        use_img2img = image_path is not None

        if self.pipe is None:
            self.setup(use_img2img=use_img2img)

        print(f"Generating texture with prompt: {prompt}")

        with torch.inference_mode():
            if use_img2img:
                init_image = Image.open(image_path).convert("RGB")
                init_image = init_image.resize((512, 512))

                image = self.pipe(
                    prompt=prompt,
                    image=init_image,
                    strength=0.75,
                    guidance_scale=7.5,
                ).images[0]
            else:
                image = self.pipe(
                    prompt=prompt,
                    width=512,
                    height=512,
                    num_inference_steps=50,
                    guidance_scale=7.5,
                ).images[0]

        image.save(output_path)
        print(f"Texture saved to: {output_path}")
        return output_path

    def slerp(self, t, v0, v1, DOT_THRESHOLD=0.9995):
        """Spherical linear interpolation"""
        if not isinstance(v0, np.ndarray):
            inputs_are_torch = True
            input_device = v0.device
            v0 = v0.cpu().numpy()
            v1 = v1.cpu().numpy()
        else:
            inputs_are_torch = False

        dot = np.sum(v0 * v1 / (np.linalg.norm(v0) * np.linalg.norm(v1)))
        if np.abs(dot) > DOT_THRESHOLD:
            v2 = (1 - t) * v0 + t * v1
        else:
            theta_0 = np.arccos(dot)
            sin_theta_0 = np.sin(theta_0)
            theta_t = theta_0 * t
            sin_theta_t = np.sin(theta_t)
            s0 = np.sin(theta_0 - theta_t) / sin_theta_0
            s1 = sin_theta_t / sin_theta_0
            v2 = s0 * v0 + s1 * v1

        if inputs_are_torch:
            v2 = torch.from_numpy(v2).to(input_device)

        return v2

def main():
    parser = argparse.ArgumentParser(description='Generate textures with Stable Diffusion')
    parser.add_argument('--prompt', type=str, required=True, help='Text prompt for generation')
    parser.add_argument('--image', type=str, help='Input image path (optional)')
    parser.add_argument('--output', type=str, default='output.png', help='Output image path')
    parser.add_argument('--json-output', action='store_true', help='Output result as JSON')

    args = parser.parse_args()

    try:
        predictor = StableDiffusionPredictor()
        output_path = predictor.generate_texture(
            prompt=args.prompt,
            image_path=args.image,
            output_path=args.output
        )

        if args.json_output:
            result = {
                "success": True,
                "output_path": output_path,
                "prompt": args.prompt
            }
            print(json.dumps(result))
        else:
            print(f"Success! Generated: {output_path}")
    except Exception as e:
        tb = traceback.format_exc()
        if args.json_output:
            result = {
                "success": False,
                "error": f"{str(e)}\n{tb}"
            }
        print(json.dumps(result))

if __name__ == "__main__":
    main()
