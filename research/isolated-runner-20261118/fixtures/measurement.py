from limits import clamp


def normalize(raw):
    return clamp(int(raw))
