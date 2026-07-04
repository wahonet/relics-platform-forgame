import tile_routes


def test_parse_zoom_list_filters_out_of_range_values():
    assert tile_routes._parse_zoom_list("12,13,1415,16") == [12, 13, 16]
    assert tile_routes._parse_zoom_list("0,1,17,18,abc") == [1, 17]


def test_tiles_for_bounds_rejects_invalid_zoom_without_overflow():
    assert tile_routes._tiles_for_bounds(116.0, 35.0, 117.0, 36.0, 1415) == []


def test_parse_provider_list_deduplicates_and_filters_unknowns():
    assert tile_routes._parse_provider_list("arcgis_sat,bad,osm,arcgis_sat") == [
        "arcgis_sat",
        "osm",
    ]
