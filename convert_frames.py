#!/usr/bin/env python3
"""Convert Grid Engine NumPy outputs into browser-ready dashboard assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


GRID_FIELDS = (
    "x_min",
    "x_max",
    "y_min",
    "y_max",
    "resolution",
    "elevation",
    "semantic_class",
    "semantic_confidence",
    "occupancy",
    "traversability",
    "point_count",
    "terrain_complexity",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("batch_grid_outputs"))
    parser.add_argument(
        "--points-source",
        type=Path,
        default=Path("batch_grid_outputs/dl_output_subset"),
    )
    parser.add_argument("--output", type=Path, default=Path("dashboard/public/frames"))
    parser.add_argument("--start", type=int, default=1000)
    parser.add_argument("--end", type=int, default=1999)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument("--max-points", type=int, default=15_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--grid-format", choices=("binary", "json"), default="binary")
    return parser.parse_args()


def native_number(value: np.generic) -> int | float:
    return value.item()


def convert_frame(
    frame_id: str,
    grid_path: Path,
    points_path: Path,
    output: Path,
    max_points: int,
    seed: int,
    grid_format: str,
) -> tuple[dict[str, int | str | dict[str, int]], set[int]]:
    with np.load(grid_path, allow_pickle=True) as archive:
        cells = archive["final_cells"]

    missing = set(GRID_FIELDS).difference(cells.dtype.names or ())
    if missing:
        raise ValueError(f"missing cell fields: {sorted(missing)}")

    if grid_format == "binary":
        grid_matrix = np.column_stack([cells[field] for field in GRID_FIELDS]).astype("<f4")
        grid_matrix.tofile(output / "grid" / f"{frame_id}_grid.bin")
    else:
        grid_records = [
            {field: native_number(row[field]) for field in GRID_FIELDS} for row in cells
        ]
        grid_file = output / "grid" / f"{frame_id}_grid.json"
        grid_file.write_text(json.dumps(grid_records, separators=(",", ":")), encoding="utf-8")

    points = np.load(points_path, mmap_mode="r")
    if points.ndim != 2 or points.shape[1] < 4:
        raise ValueError(f"expected point array with shape (N, >=4), got {points.shape}")

    input_count = int(points.shape[0])
    export_count = min(input_count, max_points)
    if input_count > export_count:
        rng = np.random.default_rng(seed + int(frame_id))
        indices = rng.choice(input_count, export_count, replace=False)
        exported = points[indices, :4]
    else:
        exported = points[:, :4]
    exported = np.ascontiguousarray(exported, dtype="<f4")
    exported.tofile(output / "points" / f"{frame_id}_points.bin")

    resolutions, counts = np.unique(cells["resolution"], return_counts=True)
    distribution = {
        f"{float(resolution):g}": int(count)
        for resolution, count in zip(resolutions, counts, strict=True)
    }
    meta: dict[str, int | str | dict[str, int]] = {
        "frame_id": frame_id,
        "total_input_points": input_count,
        "exported_points": export_count,
        "total_cells": int(len(cells)),
        "resolution_distribution": distribution,
    }
    meta_file = output / "meta" / f"{frame_id}_meta.json"
    meta_file.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    return meta, {int(value) for value in np.unique(cells["semantic_class"])}


def main() -> None:
    args = parse_args()
    if args.step <= 0 or args.max_points <= 0:
        raise SystemExit("--step and --max-points must be positive")

    for folder in ("grid", "points", "meta"):
        (args.output / folder).mkdir(parents=True, exist_ok=True)

    converted: list[str] = []
    semantic_classes: set[int] = set()
    for frame in range(args.start, args.end + 1, args.step):
        frame_id = f"{frame:06d}"
        grid_path = args.source / f"{frame_id}_grid.npz"
        points_path = args.points_source / f"{frame_id}_segmented.npy"
        if not grid_path.exists() or not points_path.exists():
            print(f"SKIP {frame_id}: matching source files not found")
            continue
        try:
            meta, frame_classes = convert_frame(
                frame_id,
                grid_path,
                points_path,
                args.output,
                args.max_points,
                args.seed,
                args.grid_format,
            )
        except Exception as error:  # Continue so one corrupt frame does not lose the set.
            print(f"ERROR {frame_id}: {error}")
            continue
        converted.append(frame_id)
        semantic_classes.update(frame_classes)
        print(
            f"OK {frame_id}: {meta['total_input_points']:,} input / "
            f"{meta['exported_points']:,} exported / {meta['total_cells']:,} cells"
        )

    manifest = {
        "frames": converted,
        "grid_format": args.grid_format,
        "grid_fields": list(GRID_FIELDS),
        "semantic_classes": sorted(semantic_classes),
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
    )
    print(f"\nConverted {len(converted)} frames to {args.output}")
    if not converted:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
